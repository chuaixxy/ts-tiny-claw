/* npx tsx cmd/claw/main.ts [cli|session|webhook|ws] [可选: 一次性 prompt] */
// 对应 Go: cmd/claw/main.go
//
// Node 提供多种对话入口（互斥，由 argv / CLAW_MODE 选择）：
//
//   cli      终端一次性任务（默认 EnableThinking=true；无参数时跑 Go 演示 prompt）
//            用法: npx tsx cmd/claw/main.ts
//                  npx tsx cmd/claw/main.ts cli "读取 a.txt 并总结"
//   repl     终端交互 REPL
//            用法: npx tsx cmd/claw/main.ts repl
//
//   session  本讲演示：并发 Session A/B（前端群 / 后端群）+ Working Memory 截断
//            用法: npx tsx cmd/claw/main.ts session
//            对应 Go 本讲 main.go 的整段并发模拟
//
//   webhook  飞书 HTTP 事件订阅（需公网 URL，对应 Go ListenAndServe）
//            用法: npx tsx cmd/claw/main.ts webhook
//
//   ws       飞书长连接 —— 仍是应用机器人收消息，但不用 HTTP EventListener
//            开放平台选「使用长连接接收事件」，本地无需公网入口
//            用法: npx tsx cmd/claw/main.ts ws

import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { setTimeout as delay } from "node:timers/promises"
import http from "node:http"
import path from "node:path"
import * as readline from "node:readline/promises"
import { stdin as input, stdout as output } from "node:process"

import * as lark from "@larksuiteoapi/node-sdk"

import { AgentEngine } from "../../internal/engine/loop.ts"
import { globalSessionMgr } from "../../internal/engine/session.ts"
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

type RunMode = "cli" | "session" | "webhook" | "ws"

const MODE_ALIASES = new Set([
  "cli",
  "repl",
  "chat",
  "session",
  "concurrent",
  "memory",
  "webhook",
  "feishu",
  "http",
  "ws",
  "websocket",
  "long-connection",
])

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
  // 对应 Go 本讲 main：并发 Session A/B + Working Memory 截断演示
  if (raw === "session" || raw === "concurrent" || raw === "memory") {
    return { mode: "session" }
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
  if (arg0 && !MODE_ALIASES.has(arg0)) {
    return { mode: "cli", oneShotPrompt: argv.join(" ").trim() }
  }

  return { mode: "cli" }
}

/** 确保工作区目录存在（WorkDir 跟随 Session，不再挂在 Engine 上） */
function ensureWorkDir(): string {
  // 对应 Go:
  //   workDir, _ := os.Getwd()
  //   workDir += "/workspace"
  const workDir = path.join(process.cwd(), "workspace")
  if (!existsSync(workDir)) {
    mkdirSync(workDir, { recursive: true })
  }
  return workDir
}

/** 1. 初始化引擎依赖（各入口共用） */
function createEngine(
  workDir: string,
  enableThinking = true,
): AgentEngine {
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

  // 实例化引擎；【注意】WorkDir 已从 Engine 移除，跟随 Session 走
  // EnableThinking = true：Phase 1 剥夺工具，强制规划后再行动
  // 飞书 ws/webhook 本讲关闭慢思考，对齐 Go 演示、减少半程等待
  return new AgentEngine(llmProvider, registry, enableThinking)
}

/**
 * 对应 Go main 里的默认演示任务：测动态 Prompt + TerminalReporter。
 * 无自定义 prompt 时跑这一条；交互 REPL 请用: npx tsx cmd/claw/main.ts repl
 */
const DEFAULT_DEMO_PROMPT = `
    我需要在当前目录下新建一个 ping.js（Node.js），提供一个简单的 http ping 接口。
    写完之后，帮我把代码用 git 提交一下。
    `

/** 本讲演示用的前后端工作区（对应 Go: /tmp/project_front|back） */
function ensureSessionDemoProjects(): {
  frontDir: string
  backDir: string
} {
  const frontDir = "/Users/chrystal/test/project_front"
  const backDir = "/Users/chrystal/test/project_back"
  mkdirSync(frontDir, { recursive: true })
  mkdirSync(backDir, { recursive: true })
  // Session A 会 read_file README.md，写入可观察的“密钥”
  writeFileSync(
    path.join(frontDir, "README.md"),
    `# Frontend Project\n\nAPI_SECRET_KEY=sk-front-demo-42\n`,
    "utf8",
  )
  writeFileSync(
    path.join(backDir, "README.md"),
    `# Backend Project\n\n(本目录故意不放密钥，用于验证 Session 隔离)\n`,
    "utf8",
  )
  return { frontDir, backDir }
}

/**
 * 对应 Go 本讲 main.go：同一无状态 AgentEngine 上并发跑 Session A / Session B。
 * - Session A（前端群）：长程对话刷爆 Working Memory(6)，观察是否忘掉第一轮密钥
 * - Session B（后端群）：错开 1s 发起，验证物理隔离（看不到 A 的历史）
 * Promise.all ≈ sync.WaitGroup
 */
async function runConcurrentSessionDemo(): Promise<void> {
  if (!process.env.LLM_API_KEY) {
    logError("请先设置 LLM_API_KEY 环境变量（可写在项目根目录 .env）")
    process.exit(1)
  }
  if (!process.env.LLM_BASE_URL) {
    logError("请先设置 LLM_BASE_URL 环境变量（可写在项目根目录 .env）")
    process.exit(1)
  }

  const { frontDir, backDir } = ensureSessionDemoProjects()

  const model = process.env.LLM_MODEL ?? "glm-4.5-air"
  const llmProvider = createOpenAIProvider(model)

  const registry = createRegistry()
  // 对应 Go: registry.Register(tools.NewReadFileTool("/tmp/project_front"))
  registry.register(createReadFileTool(frontDir))

  // 引擎本身变成无状态的，它不绑定 WorkDir（仅适用于本讲演示）
  // 对应 Go: eng := engine.NewAgentEngine(llmProvider, registry, false)
  const eng = new AgentEngine(llmProvider, registry, false)
  const reporter = createTerminalReporter()

  log("🚀 并发 Session 演示：前端群 (A) + 后端群 (B) 同时请求同一 AgentEngine")
  log(`   Working Memory limit=6；front=${frontDir} back=${backDir}`)

  // ================= 模拟并发场景 1：飞书前端群 =================
  const runSessionA = async (): Promise<void> => {
    const sessionA = globalSessionMgr.getOrCreate("chat_front_001", frontDir)

    // 回合 1：获取机密
    log("\n>>> 🙋‍♂️ [Session A / Turn 1]: 帮我看看 README.md 里记录了什么密钥？")
    sessionA.append({
      role: "user",
      content: "帮我看看 README.md 里记录了什么密钥？",
    })
    await eng.run(undefined, sessionA, reporter)

    // 故意制造大量“废话”对话，刷掉记忆 (假设 Working Memory Limit=6)
    for (let i = 0; i < 6; i++) {
      sessionA.append({ role: "user", content: "这只是一句闲聊占位符。" })
      sessionA.append({ role: "assistant", content: "好的，收到闲聊。" })
    }

    // 回合 2：验证记忆截断 (此时第一轮的密钥已经被挤出 Working Memory 了！)
    log(
      "\n>>> 🙋‍♂️ [Session A / Turn 2]: 请直接告诉我，刚才第一轮你查到的那个密钥是什么？",
    )
    sessionA.append({
      role: "user",
      content:
        "请直接告诉我，刚才第一轮你查到的那个密钥是什么？不准调用工具！",
    })
    await eng.run(undefined, sessionA, reporter)
  }

  // ================= 模拟并发场景 2：飞书后端群 =================
  const runSessionB = async (): Promise<void> => {
    // 稍微错开一点时间发起请求
    await delay(1000)

    const sessionB = globalSessionMgr.getOrCreate("chat_back_002", backDir)

    log("\n>>> 🙋‍♂️ [Session B]: 别人查到了一个密钥，你这里能看到吗？")
    sessionB.append({
      role: "user",
      content: "别人查到了一个密钥，你这里能看到吗？不准调用工具！",
    })
    await eng.run(undefined, sessionB, reporter)
  }

  // 对应 Go: wg.Wait() —— 两个“协程”都跑完再退出
  await Promise.all([runSessionA(), runSessionB()])
  log("\n✅ 并发 Session 演示结束")
}

/**
 * CLI 入口：不用飞书 EventListener，直接在终端和 Agent 对话。
 * 【注入新实现的终端输出器】对应 Go: reporter := engine.NewTerminalReporter()
 */
async function runCli(
  eng: AgentEngine,
  workDir: string,
  oneShotPrompt?: string,
  interactive = false,
): Promise<void> {
  // 【注入新实现的终端输出器】
  const reporter = createTerminalReporter()
  // CLI 复用同一 Session，多轮对话共享 Working Memory
  const session = globalSessionMgr.getOrCreate("cli", workDir)

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
          // 入口层负责把用户输入写入 Session，再唤醒引擎
          session.append({ role: "user", content: line })
          await eng.run(undefined, session, reporter)
        } catch (err) {
          logError("[CLI] 引擎运行崩溃:", err)
        }
      }
    } finally {
      rl.close()
    }
    return
  }

  // 对应 Go: err := eng.Run(context.Background(), session, reporter)
  const prompt = oneShotPrompt?.trim() || DEFAULT_DEMO_PROMPT
  log(`[CLI] EnableThinking=true，工作区=${workDir}`)
  log(`[CLI] 任务:\n${prompt}`)
  try {
    session.append({ role: "user", content: prompt })
    await eng.run(undefined, session, reporter)
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
async function runFeishuWebhook(
  eng: AgentEngine,
  workDirs: { frontDir: string; backDir: string },
): Promise<void> {
  // 2. 初始化飞书 Bot 调度器
  // 对应 Go:
  //   bot := feishu.NewFeishuBot(eng)
  //   handler := httpserverext.NewEventHandlerFunc(bot.GetEventDispatcher())
  const bot = createFeishuBot(eng, workDirs)

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
 *
 * 对齐 Go 本讲 main 的双 Session 并发测试（真实流量版）：
 *
 * ================= 模拟并发场景 1：飞书前端群 =================
 *   本地用「私聊 p2p」代替 chat_front_001 → project_front（含密钥 README）
 *   可测：读密钥 → 灌闲聊挤掉 Working Memory → 再追问是否忘掉
 *
 * ================= 模拟并发场景 2：飞书后端群 =================
 *   「群聊 group」→ project_back（故意无密钥）
 *   可测：问「别人查到的密钥你能看到吗？」——历史与文件均应隔离
 *
 * 同一无状态 AgentEngine；void handleAgentRun ≈ go func（可并发）。
 */
async function runFeishuLongConnection(
  eng: AgentEngine,
  workDirs: { frontDir: string; backDir: string },
): Promise<void> {
  const bot = createFeishuBot(eng, workDirs)
  log("🚀 ts-tiny-claw 飞书长连接模式启动中…")
  log("   请在开放平台将订阅方式改为「使用长连接接收事件」")
  log("   并发测试映射（对齐 Go GetOrCreate）：")
  log(`   · 私聊 p2p  → Session A / 前端群 → ${workDirs.frontDir}`)
  log(`   · 群聊 group → Session B / 后端群 → ${workDirs.backDir}`)
  await bot.startLongConnection()
}

async function main() {
  const { mode, oneShotPrompt, interactive } = parseMode(process.argv.slice(2))

  // 本讲 Go main 的整段并发演示（独立装配引擎，不走 workspace/ 全工具集）
  if (mode === "session") {
    await runConcurrentSessionDemo()
    return
  }

  const isFeishu = mode === "ws" || mode === "webhook"

  // 飞书：双工作区 + 关闭慢思考（对齐 Go eng := NewAgentEngine(..., false)）
  // CLI：仓库内 workspace/
  if (isFeishu) {
    const workDirs = ensureSessionDemoProjects()
    // 工具构造 fallback 用 frontDir；真正 IO 在 Run 时跟随 Session.WorkDir
    const eng = createEngine(workDirs.frontDir, /* enableThinking */ false)
    log(`[Feishu] EnableThinking=false；双工作区已就绪`)
    log(`   front(私聊/场景1)=${workDirs.frontDir}`)
    log(`   back (群聊/场景2)=${workDirs.backDir}`)

    if (mode === "webhook") {
      await runFeishuWebhook(eng, workDirs)
    } else {
      await runFeishuLongConnection(eng, workDirs)
    }
    return
  }

  const workDir = ensureWorkDir()
  const eng = createEngine(workDir, true)
  await runCli(eng, workDir, oneShotPrompt, interactive === true)
}

try {
  await main()
} catch (err) {
  logError("启动失败:", err)
  process.exit(1)
}
