/* npx tsx cmd/claw/index.ts -prompt "你的任务描述" [-dir .] [-session cli_default_session] */
// 对应 Go: cmd/claw/main.go（本讲生产力 CLI 入口）
//
// 按依赖注入图组装：Plan 模式 + CostTracker + 彩色 Terminal Reporter。
// 演示入口仍走 cmd/claw/main.ts，本文件不改动它。

import { existsSync } from "node:fs"
import path from "node:path"

import { AgentEngine } from "../../internal/engine/loop.ts"
import type { Reporter } from "../../internal/engine/reporter.ts"
import { globalSessionMgr } from "../../internal/engine/session.ts"
import { error as logError } from "../../internal/log/log.ts"
import { createCostTracker } from "../../internal/observability/tracker.ts"
import {
  exportTraceToFile,
  startSpan,
} from "../../internal/observability/trace.ts"
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

const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  magenta: "\x1b[35m",
} as const

function paint(color: string, text: string): string {
  return `${color}${text}${ANSI.reset}`
}

/**
 * 彩色 Terminal Reporter：并发工具日志用颜色区分思考 / 调用 / 成败 / 回复。
 * 对应 Go: engine.NewTerminalReporter()
 */
function createColoredTerminalReporter(): Reporter {
  return {
    async onThinking() {
      console.log(`\n${paint(ANSI.yellow, "[🤔 思考中]")} 模型正在推理...`)
    },
    async onToolCall(_ctx, toolName, args) {
      console.log(`${paint(ANSI.cyan, "[🛠️ 调用工具]")} ${toolName}`)
      let displayArgs = args.replaceAll("\n", "\\n").replaceAll("\r", "\\r")
      if (displayArgs.length > 150) {
        displayArgs = `${displayArgs.slice(0, 150)}... (已截断)`
      }
      console.log(paint(ANSI.dim, `   参数: ${displayArgs}`))
    },
    async onToolResult(_ctx, toolName, result, isError) {
      if (isError) {
        console.log(`${paint(ANSI.red, "[❌ 执行失败]")} ${toolName}`)
        if (result !== "") {
          console.log(paint(ANSI.red, `   错误: ${result}`))
        }
      } else {
        console.log(`${paint(ANSI.green, "[✅ 执行成功]")} ${toolName}`)
      }
    },
    async onMessage(_ctx, content) {
      if (content === "") return
      console.log(
        `\n${paint(ANSI.magenta + ANSI.bold, "🤖 Agent 回复:")}\n${content}\n`,
      )
    },
  }
}

/** 对应 Go: flag.String("prompt" | "dir" | "session") */
function parseArgs(argv: string[]): {
  prompt: string
  workDir: string
  sessionId: string
} {
  let prompt = ""
  let workDir = "."
  let sessionId = "cli_default_session"

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    const take = (flag: string): string | undefined => {
      if (arg === `-${flag}` || arg === `--${flag}`) {
        return argv[++i] ?? ""
      }
      if (arg.startsWith(`-${flag}=`) || arg.startsWith(`--${flag}=`)) {
        return arg.slice(arg.indexOf("=") + 1)
      }
      return undefined
    }

    const promptVal = take("prompt")
    if (promptVal !== undefined) {
      prompt = promptVal
      continue
    }
    const dirVal = take("dir")
    if (dirVal !== undefined) {
      workDir = dirVal
      continue
    }
    const sessionVal = take("session")
    if (sessionVal !== undefined) {
      sessionId = sessionVal
      continue
    }
  }

  return { prompt, workDir, sessionId }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(3)}s`
}

async function main(): Promise<void> {
  // 1. 命令行参数解析
  const { prompt, workDir: workDirFlag, sessionId } = parseArgs(
    process.argv.slice(2),
  )

  if (!prompt.trim()) {
    console.log(
      '用法: npx tsx cmd/claw/index.ts -prompt "你的任务描述" [-dir /path/to/workdir] [-session session_id]',
    )
    process.exit(1)
  }

  if (!process.env.LLM_API_KEY) {
    logError("请先设置 LLM_API_KEY 环境变量（可写在项目根目录 .env）")
    process.exit(1)
  }
  if (!process.env.LLM_BASE_URL) {
    logError("请先设置 LLM_BASE_URL 环境变量（可写在项目根目录 .env）")
    process.exit(1)
  }

  // 解析工作区绝对路径
  const workDir = path.resolve(workDirFlag)

  console.log("==================================================")
  console.log("🚀 启动 ts-tiny-claw CLI 引擎...")
  console.log(`📁 锁定工作区: ${workDir}`)
  console.log("==================================================")

  // 2. 初始化核心基础服务
  const modelName = process.env.LLM_MODEL ?? "glm-4.5-air"
  const realProvider = createOpenAIProvider(modelName)

  // 获取持久化 Session
  const sess = globalSessionMgr.getOrCreate(sessionId, workDir)

  // 【全息监控装配】：用 Cost Tracker 将真实大脑包裹起来
  const trackedProvider = createCostTracker(realProvider, modelName, sess)

  // 3. 初始化工具与执行层
  const registry = createRegistry()
  registry.register(createReadFileTool(workDir))
  registry.register(createWriteFileTool(workDir))
  registry.register(createBashTool(workDir))
  registry.register(createEditFileTool(workDir))

  // 在 CLI 模式下，我们默认开启 YOLO 模式（全权信任本地执行），
  // 因此这里暂时不挂载 Feishu 审批 Middleware。

  // 4. 初始化核心引擎（组装器内部会自动加载 Composer, Recovery, Reminders）
  // EnableThinking=false，PlanMode=true
  const eng = new AgentEngine(trackedProvider, registry, false, true)

  // 【全息追踪装配】：初始化链路追踪 Root Span
  const [ctx, rootSpan] = startSpan(undefined, "CLI.TaskRun")
  rootSpan.addAttribute("Prompt", prompt)

  try {
    // 5. 初始化彩色终端输出器
    const reporter = createColoredTerminalReporter()

    console.log(`\n🎯 收到任务: ${prompt}\n`)

    // 将用户的 Prompt 压入 Session 记忆
    sess.append({ role: "user", content: prompt })

    // 6. 发起冲锋：启动 Main Loop！
    await eng.run(ctx, sess, reporter)
  } catch (err) {
    logError("\n💥 引擎运行崩溃:", err)
    process.exit(1)
  } finally {
    rootSpan.endSpan()
    try {
      await exportTraceToFile(rootSpan, workDir, sess.id)
    } catch {
      // 对应 Go: _ = observability.ExportTraceToFile(...)
    }
  }

  console.log("\n==================================================")
  console.log(
    `✨ 任务圆满结束。总耗时: ${formatDuration(rootSpan.durationMs)}`,
  )
  console.log(
    `💰 Session 累计消耗: $${sess.totalCostCNY.toFixed(6)} | Token: Input ${sess.totalPromptTokens}, Output ${sess.totalCompletionTokens}`,
  )
  console.log("==================================================")
}

try {
  await main()
} catch (err) {
  logError("启动失败:", err)
  process.exit(1)
}
