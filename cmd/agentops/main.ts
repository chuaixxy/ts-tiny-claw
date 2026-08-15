/* npx tsx cmd/agentops/main.ts */
// 对应 Go: cmd/agentops/main.go
//
// 终极拼装：大脑 + 工具 + 安全 Middleware + CostTracker 仪表盘 + 飞书长连接。
// 开放平台事件订阅请选「使用长连接接收事件」，无需公网 Webhook / ngrok。

import { existsSync, mkdirSync } from "node:fs"
import path from "node:path"

import { AgentEngine } from "../../internal/engine/loop.ts"
import type { Session } from "../../internal/engine/session.ts"
import {
  globalApprovalMgr,
  isDangerousCommand,
} from "../../internal/feishu/approval.ts"
import {
  createFeishuBot,
  reporterFromContext,
  type AgentEngineFactory,
} from "../../internal/feishu/bot.ts"
import { error as logError, log } from "../../internal/log/log.ts"
import { createCostTracker } from "../../internal/observability/tracker.ts"
import { createOpenAIProvider } from "../../internal/provider/openai.ts"
import { createBashTool } from "../../internal/tools/bash.ts"
import { createEditFileTool } from "../../internal/tools/edit-file.ts"
import { createReadFileTool } from "../../internal/tools/read-file.ts"
import { createRegistry } from "../../internal/tools/registry.ts"
import { createWriteFileTool } from "../../internal/tools/write-file.ts"

/** Node 不会自动读 .env，启动时从工作区根目录加载 */
function loadDotEnv(): void {
  const envPath = path.resolve(process.cwd(), ".env")
  if (!existsSync(envPath)) return
  process.loadEnvFile(envPath)
}

loadDotEnv()

async function main(): Promise<void> {
  log("🚀 正在启动 ts-tiny-claw AgentOps 飞书服务端...")

  if (!process.env.LLM_API_KEY || !process.env.FEISHU_APP_ID) {
    logError("❌ 请先导出 LLM_API_KEY 和飞书相关的环境变量")
    process.exit(1)
  }
  if (!process.env.LLM_BASE_URL) {
    logError("❌ 请先设置 LLM_BASE_URL 环境变量（可写在项目根目录 .env）")
    process.exit(1)
  }

  // 1. 设定监控的物理工作区
  const workDir = path.join(process.cwd(), "workspace-v2")
  mkdirSync(workDir, { recursive: true })

  // 2. 初始化底层大脑与注册表
  const modelName = process.env.LLM_MODEL ?? "glm-4.5-air"
  const llmProvider = createOpenAIProvider(modelName)

  const registry = createRegistry()
  registry.register(createReadFileTool(workDir))
  registry.register(createWriteFileTool(workDir))
  registry.register(createEditFileTool(workDir))
  registry.register(createBashTool(workDir)) // 必备的运维工具

  // 3. 【核心防御】：注入安全拦截 Middleware
  registry.use(async (ctx, call) => {
    const argsStr =
      typeof call.arguments === "string"
        ? call.arguments
        : JSON.stringify(call.arguments ?? {})

    // 检查是否命中危险命令黑名单
    if (isDangerousCommand(call.name, argsStr)) {
      const taskID = call.id
      log(
        `[Middleware] 拦截到高危操作: ${call.name}，触发飞书审批挂起...`,
      )

      // 【驾驭魔术】：从 Context 中取出专属于发起该请求群聊的 Reporter
      // Go: feishu.ReporterFromContext(ctx).(*feishu.FeishuReporter)
      // Node: WaitForApproval 已收 Reporter，无需强转 sendMsg
      const currentReporter = reporterFromContext(ctx) ?? null

      // 当前 async 调用挂起，向飞书发送卡片，等待人类决定
      const { allowed, reason } = await globalApprovalMgr.waitForApproval(
        taskID,
        call.name,
        argsStr,
        currentReporter,
      )

      if (!allowed) {
        return { allowed: false, rejectReason: reason } // 拒绝，将理由喂回给大模型
      }
      return { allowed: true, rejectReason: "" } // 同意，放行底层物理执行
    }

    // 普通读取命令，YOLO 放行
    return { allowed: true, rejectReason: "" }
  })
  log("🛡️ 安全防御 Middleware 已挂载。")

  // 4. 动态 Factory 组装器：保证高并发调用的物理独立性与账单准确追踪
  const engineFactory: AgentEngineFactory = (session: Session) => {
    // 让 Tracker 绑定当前特定用户的 Session 账本
    const trackedProvider = createCostTracker(llmProvider, modelName, session)
    return new AgentEngine(trackedProvider, registry, false, false)
  }

  // 5. 初始化飞书 Bot 调度中心，并以长连接收事件
  const bot = createFeishuBot(engineFactory, workDir)
  log("📡 飞书长连接模式启动中…")
  log("   请在开放平台将订阅方式改为「使用长连接接收事件」")
  await bot.startLongConnection()
}

try {
  await main()
} catch (err) {
  logError("启动失败:", err)
  process.exit(1)
}
