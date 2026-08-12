/* npx tsx cmd/claw/main.ts [cli|webhook|ws] [可选: 一次性 prompt] */
// 对应 Go: cmd/claw/main.go（Go 原版只有飞书 HTTP Webhook 入口）
//
// Node 提供三种对话入口（互斥，由 argv / CLAW_MODE 选择）：
//
//   cli      终端一次性任务（默认 EnableThinking=true；无参数时跑 Go 演示 prompt）
//            用法: npx tsx cmd/claw/main.ts
//                  npx tsx cmd/claw/main.ts cli "读取 a.txt 并总结"
//   repl     终端交互 REPL
//            用法: npx tsx cmd/claw/main.ts repl
//
//   webhook  飞书 HTTP 事件订阅（需公网 URL，对应 Go ListenAndServe）
//            用法: npx tsx cmd/claw/main.ts webhook
//
//   ws       飞书长连接 —— 仍是应用机器人收消息，但不用 HTTP EventListener
//            开放平台选「使用长连接接收事件」，本地无需公网入口
//            用法: npx tsx cmd/claw/main.ts ws

import { existsSync, mkdirSync } from "node:fs"
import http from "node:http"
import path from "node:path"
import * as readline from "node:readline/promises"
import { stdin as input, stdout as output } from "node:process"

import * as lark from "@larksuiteoapi/node-sdk"

import { AgentEngine } from "../../internal/engine/loop.ts"
import { createTerminalReporter } from "../../internal/engine/terminal-reporter.ts"
import { createFeishuBot } from "../../internal/feishu/bot.ts"
import { error as logError, log } from "../../internal/log/log.ts"
import { createOpenAIProvider } from "../../internal/provider/openai.ts"
// 也可换成 Claude 兼容端点：createClaudeProvider from "../../internal/provider/claude.ts"
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

type RunMode = "cli" | "webhook" | "ws"

function parseMode(argv: string[]): {
  mode: RunMode
  oneShotPrompt?: string
  interactive?: boolean
} {
  // 优先 CLAW_MODE；否则看第一个参数；默认 cli（本地对话、不依赖飞书）
  const envMode = process.env.CLAW_MODE?.trim().toLowerCase()
  const arg0 = argv[0]?.toLowerCase()

  const raw = envMode || arg0 || "cli"
  if (raw === "webhook" || raw === "feishu" || raw === "http") {
    return { mode: "webhook" }
  }
  if (raw === "ws" || raw === "websocket" || raw === "long-connection") {
    return { mode: "ws" }
  }
  // repl / chat：交互式；cli 或不带模式：一次性（默认跑 Go 演示 prompt）
  if (raw === "repl" || raw === "chat") {
    return { mode: "cli", interactive: true }
  }
  if (raw === "cli") {
    const oneShot = argv.slice(1).join(" ").trim()
    return oneShot
      ? { mode: "cli", oneShotPrompt: oneShot }
      : { mode: "cli" }
  }

  // 未识别的首参：当作 cli 的一次性 prompt（方便 npx tsx cmd/claw/main.ts 帮我读 a.txt）
  if (
    arg0 &&
    !["webhook", "feishu", "http", "ws", "websocket", "long-connection"].includes(
      arg0,
    )
  ) {
    return { mode: "cli", oneShotPrompt: argv.join(" ").trim() }
  }

  return { mode: "cli" }
}

/** 1. 初始化引擎依赖（各入口共用） */
function createEngine(): AgentEngine {
  // 对应 Go:
  //   workDir, _ := os.Getwd()
  //   workDir += "/workspace"
  const workDir = path.join(process.cwd(), "workspace")
  if (!existsSync(workDir)) {
    mkdirSync(workDir, { recursive: true })
  }

  // 默认使用智谱 GLM-4（Go 检查 ZHIPU_API_KEY；本仓库统一用 OpenAI 兼容的 LLM_*）
  if (!process.env.LLM_API_KEY) {
    logError("请先设置 LLM_API_KEY 环境变量（可写在项目根目录 .env）")
    process.exit(1)
  }
  if (!process.env.LLM_BASE_URL) {
    logError("请先设置 LLM_BASE_URL 环境变量（可写在项目根目录 .env）")
    process.exit(1)
  }

  // 对应 Go: llmProvider := provider.NewZhipuOpenAIProvider("glm-4.5-air")
  const model = process.env.LLM_MODEL ?? "glm-4.5-air"
  const llmProvider = createOpenAIProvider(model)

  const registry = createRegistry()
  registry.register(createReadFileTool(workDir))
  registry.register(createWriteFileTool(workDir))
  registry.register(createBashTool(workDir))
  registry.register(createEditFileTool(workDir))

  // 实例化引擎，开启慢思考
  // 对应 Go: eng := engine.NewAgentEngine(llmProvider, registry, workDir, true)
  // EnableThinking = true：Phase 1 剥夺工具，强制规划后再行动
  const enableThinking = true
  return new AgentEngine(llmProvider, registry, workDir, enableThinking)
}

/**
 * 对应 Go main 里的默认演示任务：测动态 Prompt + TerminalReporter。
 * 无自定义 prompt 时跑这一条；交互 REPL 请用: npx tsx cmd/claw/main.ts repl
 */
const DEFAULT_DEMO_PROMPT = `
    我需要在当前目录下新建一个 ping.js（Node.js），提供一个简单的 http ping 接口。
    写完之后，帮我把代码用 git 提交一下。
    `

/**
 * CLI 入口：不用飞书 EventListener，直接在终端和 Agent 对话。
 * 【注入新实现的终端输出器】对应 Go: reporter := engine.NewTerminalReporter()
 */
async function runCli(
  eng: AgentEngine,
  oneShotPrompt?: string,
  interactive = false,
): Promise<void> {
  // 【注入新实现的终端输出器】
  const reporter = createTerminalReporter()

  if (interactive) {
    log("🚀 ts-tiny-claw CLI REPL（EnableThinking=true，工作区 workspace/）")
    log("   输入任务后回车；空行或 exit / quit 退出")
    log("   其他入口: npx tsx cmd/claw/main.ts webhook | ws")
    log("   调试引擎内部轨迹: CLAW_VERBOSE=1 npx tsx cmd/claw/main.ts")

    const rl = readline.createInterface({ input, output })
    try {
      while (true) {
        const line = (await rl.question("\n你> ")).trim()
        if (!line || line === "exit" || line === "quit") {
          log("[CLI] 再见")
          break
        }
        try {
          await eng.run(undefined, line, reporter)
        } catch (err) {
          logError("[CLI] 引擎运行崩溃:", err)
        }
      }
    } finally {
      rl.close()
    }
    return
  }

  // 对应 Go: err := eng.Run(context.Background(), prompt, reporter)
  const prompt = oneShotPrompt?.trim() || DEFAULT_DEMO_PROMPT
  log(`[CLI] EnableThinking=true，工作区=${eng.workDir}`)
  log(`[CLI] 任务:\n${prompt}`)
  try {
    await eng.run(undefined, prompt, reporter)
  } catch (err) {
    // 对应 Go: log.Fatalf("引擎运行崩溃: %v", err)
    logError("引擎运行崩溃:", err)
    process.exit(1)
  }
}

/**
 * 飞书 HTTP Webhook 入口（对应 Go main）。
 * 需要公网可达的请求地址；内网 IP（如 172.19.x.x）飞书云无法校验。
 */
async function runFeishuWebhook(eng: AgentEngine): Promise<void> {
  // 2. 初始化飞书 Bot 调度器
  // 对应 Go:
  //   bot := feishu.NewFeishuBot(eng)
  //   handler := httpserverext.NewEventHandlerFunc(bot.GetEventDispatcher())
  const bot = createFeishuBot(eng)

  // 3. 注册路由并启动 HTTP 服务
  // 对应 Go: http.HandleFunc("/webhook/event", handler)
  //
  // 【飞书 URL 校验 / Challenge】：
  // 填写请求地址并保存时，飞书 POST type=url_verification + challenge；
  // 须在 1 秒内返回 {"challenge":"..."}。适配器需 autoChallenge: true。
  // 若配置了 Encrypt Key，FEISHU_ENCRYPT_KEY 必须一致。
  const port = Number(process.env.PORT ?? 48080)
  const dispatcher = bot.getEventDispatcher()
  const webhookHandler = lark.adaptDefault("/webhook/event", dispatcher, {
    autoChallenge: true,
  })

  const server = http.createServer((req, res) => {
    const pathname = (req.url ?? "").split("?")[0] ?? ""
    if (pathname !== "/webhook/event") {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" })
      res.end("not found")
      return
    }
    req.url = "/webhook/event"
    res.setHeader("Content-Type", "application/json; charset=utf-8")
    // 打印入站，便于确认飞书云是否真的打到本机（内网 IP 通常打不到）
    log(`[Feishu][Webhook] ${req.method} ${pathname} from ${req.socket.remoteAddress ?? "?"}`)
    void webhookHandler(req, res)
  })

  await new Promise<void>((resolve, reject) => {
    server.listen(port, () => {
      log(`🚀 ts-tiny-claw 飞书 Webhook 已启动，监听 :${port}`)
      log(`   路径: http://localhost:${port}/webhook/event`)
      log(`   注意: 请求地址必须是公网 IPv4；内网可用 ws 长连接入口`)
      resolve()
    })
    server.on("error", (err) => {
      logError("服务器启动失败:", err)
      reject(err)
    })
  })
}

/**
 * 飞书长连接入口：不用 HTTP EventListener / 不用公网 Webhook URL。
 * 开放平台事件订阅方式选「使用长连接接收事件」。
 */
async function runFeishuLongConnection(eng: AgentEngine): Promise<void> {
  const bot = createFeishuBot(eng)
  log("🚀 ts-tiny-claw 飞书长连接模式启动中…")
  log("   请在开放平台将订阅方式改为「使用长连接接收事件」")
  await bot.startLongConnection()
}

async function main() {
  const { mode, oneShotPrompt, interactive } = parseMode(process.argv.slice(2))
  const eng = createEngine()

  switch (mode) {
    case "cli":
      await runCli(eng, oneShotPrompt, interactive === true)
      break
    case "webhook":
      await runFeishuWebhook(eng)
      break
    case "ws":
      await runFeishuLongConnection(eng)
      break
  }
}

try {
  await main()
} catch (err) {
  logError("启动失败:", err)
  process.exit(1)
}
