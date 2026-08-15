// internal/feishu/approval.ts
// 对应 Go: internal/feishu/approval.go
//
// 当 Middleware 判断需要拦截时，把当前工具调用挂起；飞书 Webhook（或其它入口）
// 在另一条异步路径上 Resolve，从而在两者之间传递放行/拒绝信号。

import type { Reporter } from "../engine/reporter.ts"
import { log } from "../log/log.ts"

/** ApprovalResult 审批结果包 */
export interface ApprovalResult {
  allowed: boolean
  reason: string
}

/**
 * 对应 Go 的 chan ApprovalResult（容量 1）。
 * Node 没有 channel，用 Promise resolver 实现同等的挂起 / 唤醒语义。
 */
type ApprovalWaiter = {
  resolve: (result: ApprovalResult) => void
}

/** ApprovalManager 统一管理当前正在等待人类审批的任务 */
export class ApprovalManager {
  // Key 是用于审批的唯一 TaskID，Value 是接收审批结果的 Waiter
  private readonly pendingTasks = new Map<string, ApprovalWaiter>()

  /**
   * WaitForApproval 发送飞书通知，并挂起当前异步调用等待回调结果。
   * 对应 Go: 阻塞当前协程直到 <-ch。
   */
  async waitForApproval(
    taskID: string,
    toolName: string,
    args: string,
    reporter: Reporter | null,
  ): Promise<{ allowed: boolean; reason: string }> {
    // 1. 创建用于挂起当前引擎调用的 Promise
    const waitPromise = new Promise<ApprovalResult>((resolve) => {
      this.pendingTasks.set(taskID, { resolve })
    })

    // 2. 通过 Reporter 向飞书发送请求信息
    // (在实际的高级应用中，这里可以构建一张带有交互 Button 的精致飞书卡片)
    const noticeMsg = `⚠️ **高危操作审批请求**
Agent 试图执行以下动作:
- 工具: ${toolName}
- 参数: ${args}

任务 ID: **${taskID}**

👉 请在此消息下方回复 "approve ${taskID}" 或 "reject ${taskID}" 来决定是否放行。`

    // Reporter 由 handleAgentRun 经 TraceContext 传入，不再从 Bot 全局字段读取
    if (reporter) {
      await reporter.onMessage(undefined, noticeMsg)
    } else {
      // 回退到终端打印 (兼容本地 CLI 模式)
      console.log(
        `\n\x1b[31m[需要审批 TaskID: ${taskID}]\x1b[0m ${noticeMsg}\n`,
      )
    }

    log(`[Approval] 已发送审批请求 (TaskID: ${taskID})，协程挂起等待...`)

    // 3. 【驾驭核心】：挂起等待飞书 Webhook（或其它入口）唤醒！
    const result = await waitPromise

    // 4. 获取到结果后，清理内存资源
    this.pendingTasks.delete(taskID)

    return { allowed: result.allowed, reason: result.reason }
  }

  /** 当前仍在等待人类审批的 TaskID 列表 */
  pendingTaskIDs(): string[] {
    return Array.from(this.pendingTasks.keys())
  }

  /** ResolveApproval 由飞书 Webhook 回调触发，向 waiter 发送信号解开挂起 */
  resolveApproval(taskID: string, allowed: boolean, reason: string): void {
    const waiter = this.pendingTasks.get(taskID)

    if (waiter) {
      log(
        `[Approval] 收到来自飞书的审批结果 (TaskID: ${taskID}, Allowed: ${allowed})`,
      )
      waiter.resolve({ allowed, reason })
    } else {
      log(
        `[Approval] 找不到对应的 TaskID: ${taskID}，可能已超时或处理完毕`,
      )
    }
  }
}

/** 全局单例，方便在 Registry Middleware 和 Feishu Webhook 之间共享状态 */
export const globalApprovalMgr = new ApprovalManager()

/**
 * IsDangerousCommand 简单的正则检查黑名单，判断该工具调用是否需要触发人类审批。
 * 对应 Go: approval.go 第 22 讲剧本修正版。
 */
export function isDangerousCommand(toolName: string, args: string): boolean {
  // 白名单放行：对于纯读取工具，默认 YOLO 模式，全部放行
  if (toolName === "read_file") {
    return false
  }

  // 【剧本设定】：在生产服务器的 AgentOps 场景下，修改任何文件都是高危操作！
  // 我们不允许 Agent 擅自使用 write_file 覆写文件，或使用 edit_file 篡改代码。
  if (toolName === "write_file" || toolName === "edit_file") {
    return true
  }

  // 针对 bash 的高危模式匹配
  if (toolName === "bash") {
    // 危险指令特征库 (模拟真实的运维黑名单)
    const dangerousPatterns = [
      /rm\s+-r/, // 级联删除
      /sudo\s+/, // 提权操作
      /drop\s+/, // 数据库危险命令
      />.*\.go/, // 恶意覆盖源代码
      /nginx\s+-s/, // 【针对第 22 讲剧本】：拦截 Nginx 服务重启或停止
      /systemctl\s+/, // 拦截系统级服务管理
      /kill\s+/, // 拦截杀进程操作
    ]
    for (const p of dangerousPatterns) {
      if (p.test(args)) {
        return true // 命中任何一条黑名单，必须挂起审批
      }
    }
  }

  // 如果没有命中高危特征，默认放行 (例如简单的 ls -la, tail -n 50 等探测命令)
  return false
}
