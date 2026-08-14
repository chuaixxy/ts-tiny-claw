// internal/engine/reminder.ts
// 对应 Go: internal/engine/reminder.go
//
// ReminderInjector 负责在运行时监控上下文，并在模型陷入执念时动态注入强力打断信息。

import { createHash } from "node:crypto"

import { log } from "../log/log.ts"
import type { Message, ToolCall, ToolResult } from "../schema/message.ts"

/** ReminderInjector 负责在运行时监控上下文，并在模型陷入执念时动态注入强力打断信息 */
export class ReminderInjector {
  /** 用于记录连续失败的工具调用指纹 (ToolName + Arguments 的 Hash) */
  private consecutiveFailures = new Map<string, number>()

  /**
   * CheckAndInject 分析本轮的执行结果，决定是否要在 Context 尾部追加 Reminder。
   * 返回的 Message 将作为最新的用户输入，强制大模型优先阅读。
   */
  checkAndInject(
    lastToolCall: ToolCall,
    lastResult: ToolResult,
  ): Message | null {
    const fingerprint = generateFingerprint(
      lastToolCall.name,
      toArgsBytes(lastToolCall.arguments),
    )

    // 如果工具执行成功，说明 Agent 在这条路径上走通了，清空所有失败计数器
    if (!lastResult.isError) {
      this.consecutiveFailures.clear()
      return null
    }

    // 如果执行失败，累加该特征的失败次数
    const failCount = (this.consecutiveFailures.get(fingerprint) ?? 0) + 1
    this.consecutiveFailures.set(fingerprint, failCount)

    log(
      `[Reminder] 监控到工具 ${lastToolCall.name} 执行失败，该参数特征连续失败次数: ${failCount}`,
    )

    // 【驾驭底线】：触发死循环打断机制！
    // 我们设定阈值为 3 次。如果大模型连续 3 次都在同一个地方跌倒，必须强行打断它的局部执念。
    if (failCount >= 3) {
      log("[Reminder] ⚠️ 触发死循环干预！注入强力修正指令。")

      // 构造一条极其严厉的行动指南
      const nudgeMsg = `[SYSTEM REMINDER 警告] 
你似乎陷入了死循环。你刚刚连续 ${failCount} 次使用相同的参数调用了 '${lastToolCall.name}' 工具，并且都失败了。
请立即停止这种无效的重试！你的注意力被当前的报错过度吸引了。
你需要：
1. 停止猜测参数。跳出当前的局部思维。
2. 彻底改变你的策略。
3. 如果你确实无法通过系统工具解决当前问题，请直接结束任务并向用户说明你需要什么人工帮助，而不是继续盲目消耗 API 资源尝试。`

      return {
        // 【核心】必须是 RoleUser，以保证在下一次 API 请求时拥有最高的近因效应权重
        role: "user",
        content: nudgeMsg,
      }
    }

    return null
  }
}

/** 生成工具调用的唯一指纹，用于判断大模型是否在重复相同的动作 */
function generateFingerprint(toolName: string, args: Uint8Array): string {
  return createHash("md5")
    .update(toolName)
    .update(args)
    .digest("hex")
}

/** 将 ToolCall.arguments 规范为字节，便于稳定哈希（对应 Go 的 []byte Arguments） */
function toArgsBytes(args: unknown): Uint8Array {
  if (args instanceof Uint8Array) return args
  if (typeof args === "string") return new TextEncoder().encode(args)
  return new TextEncoder().encode(JSON.stringify(args ?? null))
}

/** 工厂：对应 Go 的 NewReminderInjector */
export function createReminderInjector(): ReminderInjector {
  return new ReminderInjector()
}
