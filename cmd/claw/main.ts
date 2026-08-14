/* npx tsx cmd/claw/main.ts */
// 对应 Go: cmd/claw/main.go
//
// 本讲默认：Tracing 链路追踪 —— Agent.Run / Turn / LLM / Tool 调用树写入 .claw/traces。
//            用法: npx tsx cmd/claw/main.ts
//
// 其它入口（互斥，由 argv / CLAW_MODE 选择）：
//   observability / tracker  CostTracker Token/费用仪表盘
//   -prompt  自定义一次性任务
//   subagent 多智能体协同演示
//   doom     死循环干预演示
//   session  并发 Session A/B mock + Working Memory 截断
//   repl     终端交互 REPL
//   webhook  飞书 HTTP 事件订阅（需公网 URL）
//   ws       飞书长连接（开放平台选「使用长连接接收事件」）

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
import {
  globalApprovalMgr,
  isDangerousCommand,
} from "../../internal/feishu/approval.ts"
import { error as logError, log } from "../../internal/log/log.ts"
import { createCostTracker } from "../../internal/observability/tracker.ts"
import { createOpenAIProvider } from "../../internal/provider/openai.ts"
// 也可换成 Claude 兼容端点：createClaudeProvider from "../../internal/provider/claude.ts"
import { createBashTool } from "../../internal/tools/bash.ts"
import { createEditFileTool } from "../../internal/tools/edit-file.ts"
import { createReadFileTool } from "../../internal/tools/read-file.ts"
import {
  createRegistry,
  type Registry,
} from "../../internal/tools/registry.ts"
import { createSubagentTool } from "../../internal/tools/subagent.ts"
import { createWriteFileTool } from "../../internal/tools/write-file.ts"

/** Node 不会自动读 .env，启动时从工作区根目录加载 */
function loadDotEnv(): void {
  const envPath = path.resolve(process.cwd(), ".env")
  if (!existsSync(envPath)) return
  process.loadEnvFile(envPath)
}

loadDotEnv()

type RunMode =
  | "trace"
  | "observability"
  | "subagent"
  | "doom"
  | "prompt"
  | "session"
  | "repl"
  | "webhook"
  | "ws"

const MODE_ALIASES = new Set([
  "trace",
  "tracing",
  "observability",
  "tracker",
  "subagent",
  "doom",
  "doomloop",
  "recovery",
  "session",
  "concurrent",
  "memory",
  "repl",
  "chat",
  "webhook",
  "feishu",
  "http",
  "ws",
  "websocket",
  "long-connection",
])

/**
 * 对应 Go: flag.String("prompt", "", ...) + flag.Parse()
 * 同时兼容 --prompt / -prompt，以及历史入口模式名。
 * 本讲无参默认走 Tracing 链路追踪演示。
 */
function parseArgs(argv: string[]): {
  mode: RunMode
  prompt: string
} {
  let prompt = ""
  const rest: string[] = []

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === "-prompt" || arg === "--prompt") {
      prompt = argv[++i] ?? ""
      continue
    }
    if (arg.startsWith("-prompt=") || arg.startsWith("--prompt=")) {
      prompt = arg.slice(arg.indexOf("=") + 1)
      continue
    }
    rest.push(arg)
  }

  const envMode = process.env.CLAW_MODE?.trim().toLowerCase()
  const arg0 = rest[0]?.toLowerCase()
  const raw = envMode || arg0 || ""

  if (raw === "webhook" || raw === "feishu" || raw === "http") {
    return { mode: "webhook", prompt }
  }
  if (raw === "ws" || raw === "websocket" || raw === "long-connection") {
    return { mode: "ws", prompt }
  }
  if (raw === "session" || raw === "concurrent" || raw === "memory") {
    return { mode: "session", prompt }
  }
  if (raw === "repl" || raw === "chat") {
    return { mode: "repl", prompt }
  }
  if (raw === "doom" || raw === "doomloop" || raw === "recovery") {
    return { mode: "doom", prompt }
  }
  if (raw === "subagent") {
    return { mode: "subagent", prompt }
  }
  if (raw === "observability" || raw === "tracker") {
    return { mode: "observability", prompt }
  }
  if (raw === "trace" || raw === "tracing") {
    return { mode: "trace", prompt }
  }

  // 显式提供了 -prompt：跑自定义任务
  if (prompt.trim()) {
    return { mode: "prompt", prompt }
  }

  // 未识别的首参且不像模式名：当作 prompt 兜底
  if (arg0 && !MODE_ALIASES.has(arg0)) {
    return { mode: "prompt", prompt: rest.join(" ").trim() }
  }

  // 对应 Go 本讲默认：带 Tracing 链路追踪的测试
  return { mode: "trace", prompt }
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

/**
 * 初始化引擎依赖。
 * 对应 Go: NewAgentEngine(llmProvider, registry, enableThinking, planMode)
 * 返回 registry，便于在 bot 创建后挂载审批 Middleware。
 */
function createEngine(
  workDir: string,
  enableThinking = false,
  planMode = false,
): { eng: AgentEngine; registry: Registry } {
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

  // 挂载 4 大基础工具
  const registry = createRegistry()
  registry.register(createReadFileTool(workDir))
  registry.register(createWriteFileTool(workDir))
  registry.register(createBashTool(workDir))
  registry.register(createEditFileTool(workDir))

  // 实例化引擎；【注意】WorkDir 已从 Engine 移除，跟随 Session 走
  // 本讲默认：EnableThinking=false，PlanMode=false
  const eng = new AgentEngine(llmProvider, registry, enableThinking, planMode)
  return { eng, registry }
}

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
 * 对应上一讲 Session mock：同一无状态 AgentEngine 上并发跑 Session A / Session B。
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
  const eng = new AgentEngine(llmProvider, registry, false, false)
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
 * 本讲默认入口：对齐 Go main —— Tracing 并发工具调用树导出到 .claw/traces。
 */
const TRACE_DEMO_PROMPT = `请同时帮我做两件事（必须在同一次回复里并行发起两个工具调用，不要合并成一条命令）：
1. 用 write_file 创建文件 trace_test.md，内容写「测试并发的写入」
2. 用 bash 执行：sleep 2 && echo "系统环境检查完毕"
两个都完成后，再用 bash 执行 ls -la trace_test.md && cat trace_test.md 验证文件。`

async function runTraceDemo(workDir: string): Promise<void> {
  if (!process.env.LLM_API_KEY) {
    logError("请先设置 LLM_API_KEY 环境变量（可写在项目根目录 .env）")
    process.exit(1)
  }
  if (!process.env.LLM_BASE_URL) {
    logError("请先设置 LLM_BASE_URL 环境变量（可写在项目根目录 .env）")
    process.exit(1)
  }

  const model = process.env.LLM_MODEL ?? "glm-4.5-air"
  const llmProvider = createOpenAIProvider(model)

  const sessionID = "test_trace_001"
  const sess = globalSessionMgr.getOrCreate(sessionID, workDir)

  const registry = createRegistry()
  registry.register(createBashTool(workDir))
  registry.register(createWriteFileTool(workDir))

  const eng = new AgentEngine(llmProvider, registry, false, false)
  const reporter = createTerminalReporter()

  log("\n>>> 🚀 启动带 Tracing 链路追踪的测试...")
  sess.append({ role: "user", content: TRACE_DEMO_PROMPT })

  try {
    await eng.run(undefined, sess, reporter)
  } catch (err) {
    logError("引擎运行崩溃:", err)
    process.exit(1)
  }
}

/**
 * 上一讲入口：CostTracker 包裹真实 Provider，打印 Token/费用仪表盘。
 */
const OBSERVABILITY_DEMO_PROMPT = `请用 bash 帮我用 date 命令查一下现在的时间。`

async function runObservabilityDemo(workDir: string): Promise<void> {
  if (!process.env.LLM_API_KEY) {
    logError("请先设置 LLM_API_KEY 环境变量（可写在项目根目录 .env）")
    process.exit(1)
  }
  if (!process.env.LLM_BASE_URL) {
    logError("请先设置 LLM_BASE_URL 环境变量（可写在项目根目录 .env）")
    process.exit(1)
  }

  const modelName = process.env.LLM_MODEL ?? "glm-4.5-air"

  // 1. 初始化真实的底层大脑
  const realProvider = createOpenAIProvider(modelName)

  const sessionID = "test_observability_001"
  const sess = globalSessionMgr.getOrCreate(sessionID, workDir)

  // 2. 核心拼装：用 Tracker 将真实的大脑包裹起来
  const trackedProvider = createCostTracker(realProvider, modelName, sess)

  const registry = createRegistry()
  registry.register(createBashTool(workDir))

  // 3. 将被包裹的 Provider 注入给 Engine (Engine 毫不知情)
  const eng = new AgentEngine(trackedProvider, registry, false, false)
  const reporter = createTerminalReporter()

  log("\n>>> 🚀 启动带仪表盘的可观测性测试...")
  sess.append({ role: "user", content: OBSERVABILITY_DEMO_PROMPT })

  try {
    await eng.run(undefined, sess, reporter)
  } catch (err) {
    logError("引擎运行崩溃:", err)
    process.exit(1)
  }

  log("\n================ 财务报表 ================")
  log(`会话 ID: ${sess.id}`)
  log(`总消耗 Input Tokens: ${sess.totalPromptTokens}`)
  log(`总消耗 Output Tokens: ${sess.totalCompletionTokens}`)
  log(`总计费用 (CNY): ¥${sess.totalCostCNY.toFixed(6)}`)
  log("==========================================")
}

/**
 * 上一讲入口：主引擎全功能兵器库 + 子智能体只读冷兵器库。
 */
const SUBAGENT_DEMO_PROMPT = `
    我需要你在这个遗留项目里，找到那个“核心密码”。
    为了防止污染主上下文，请你务必派出子智能体（spawn_subagent）去执行探索任务。
    你可以让子智能体使用 bash 去查找当前目录（及其所有子目录）下名为 config.txt 的文件。
    子智能体拿到密码向你汇报后，请你亲自使用 write_file 工具，将密码写在根目录的 answer.txt 里。
`

async function runSubagentDemo(workDir: string): Promise<void> {
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
  const reporter = createTerminalReporter()

  // 【防御沙箱】为子智能体准备受限的只读注册表
  const readOnlyRegistry = createRegistry()
  readOnlyRegistry.register(createReadFileTool(workDir))
  readOnlyRegistry.register(createBashTool(workDir)) // 允许简单的 grep 等搜索操作

  // 为主智能体准备全功能注册表
  const mainRegistry = createRegistry()
  mainRegistry.register(createReadFileTool(workDir))
  mainRegistry.register(createWriteFileTool(workDir))
  mainRegistry.register(createBashTool(workDir))
  mainRegistry.register(createEditFileTool(workDir))

  // 初始化主引擎
  // 对应 Go: eng := engine.NewAgentEngine(llmProvider, mainRegistry, false, false)
  const eng = new AgentEngine(llmProvider, mainRegistry, false, false)

  // 【核心装配】：将带有 Engine 引用和只读 Registry 的 Subagent 工具注册进主线
  mainRegistry.register(createSubagentTool(eng, readOnlyRegistry, reporter))

  const sessionID = "test_subagent_001"
  const sess = globalSessionMgr.getOrCreate(sessionID, workDir)

  log("\n>>> 🚀 启动多智能体协同测试...")
  sess.append({ role: "user", content: SUBAGENT_DEMO_PROMPT })

  try {
    await eng.run(undefined, sess, reporter)
  } catch (err) {
    logError("引擎运行崩溃:", err)
    process.exit(1)
  }
}

/**
 * 本讲上一入口：关闭 PlanMode，诱导模型对不存在的文件原样重试 read_file，
 * 以便观察 ReminderInjector 在连续失败后的死循环干预。
 */
const DOOM_LOOP_PROMPT = `
    帮我读取当前目录下的 secret_key.txt。
    注意：我们的文件系统现在非常不稳定，经常报 File Not Found。
    如果报错了，请你【千万不要改变参数】，直接原样再次调用 read_file 尝试，直到成功或连续重试 5 次为止。
`

async function runDoomLoopDemo(workDir: string): Promise<void> {
  // 关闭 Plan 模式，让它在死胡同里专注地展示挣扎过程
  // 对应 Go: eng := engine.NewAgentEngine(llmProvider, registry, false, false)
  const { eng } = createEngine(workDir, false, false)
  const reporter = createTerminalReporter()

  const sessionID = "test_doom_loop_001"
  const sess = globalSessionMgr.getOrCreate(sessionID, workDir)

  log("\n>>> 🚀 启动死循环干预测试...")
  sess.append({ role: "user", content: DOOM_LOOP_PROMPT })

  try {
    await eng.run(undefined, sess, reporter)
  } catch (err) {
    logError("引擎运行崩溃:", err)
    process.exit(1)
  }
}

/**
 * 自定义 -prompt 入口（本讲同样关闭 PlanMode）。
 */
async function runOneShotPrompt(
  eng: AgentEngine,
  workDir: string,
  prompt: string,
): Promise<void> {
  const reporter = createTerminalReporter()
  const sessionID = "task_web_server_01"
  const sess = globalSessionMgr.getOrCreate(sessionID, workDir)

  log(`\n>>> 🚀 收到指令: ${prompt}`)
  sess.append({ role: "user", content: prompt })

  try {
    await eng.run(undefined, sess, reporter)
  } catch (err) {
    logError("引擎运行崩溃:", err)
    process.exit(1)
  }
}

/** 交互式 REPL（非本讲默认；保留以便本地调试） */
async function runRepl(eng: AgentEngine, workDir: string): Promise<void> {
  const reporter = createTerminalReporter()
  const session = globalSessionMgr.getOrCreate("cli", workDir)

  log("🚀 ts-tiny-claw CLI REPL（工作区 workspace/）")
  log("   输入任务后回车；空行或 exit / quit 退出")
  log("   本讲默认用法: npx tsx cmd/claw/main.ts")
  log("   调试引擎内部轨迹: CLAW_VERBOSE=1 ...")

  const rl = readline.createInterface({ input, output })
  try {
    while (true) {
      const line = (await rl.question("\n你> ")).trim()
      if (!line || line === "exit" || line === "quit") {
        log("[CLI] 再见")
        break
      }
      try {
        session.append({ role: "user", content: line })
        await eng.run(undefined, session, reporter)
      } catch (err) {
        logError("[CLI] 引擎运行崩溃:", err)
      }
    }
  } finally {
    rl.close()
  }
}

/**
 * 飞书 HTTP Webhook 入口（本讲默认）。
 * 对应 Go main：绑定 Session + 注册高危命令审批 Middleware + 启动 :48080。
 */
async function runFeishuWebhook(
  eng: AgentEngine,
  registry: Registry,
  workDir: string,
): Promise<void> {
  // 假设一个 bot 绑定一个 session
  // 对应 Go: sessionID := "test_command_intercept_001"
  const sessionID = "test_command_intercept_001"
  const sess = globalSessionMgr.getOrCreate(sessionID, workDir)
  sess.append({ role: "user", content: "" })

  // 对应 Go: bot := feishu.NewFeishuBot(eng, sess)
  const bot = createFeishuBot(eng, sess)

  // 【核心注入】注册安全拦截 Middleware
  registry.use(async (_ctx, call) => {
    const argsStr =
      typeof call.arguments === "string"
        ? call.arguments
        : JSON.stringify(call.arguments ?? {})

    // 检查是否命中高危特征库
    if (isDangerousCommand(call.name, argsStr)) {
      const taskID = call.id // 使用大模型生成的唯一 ToolCallID 作为 TaskID

      // 挂起当前异步调用，发送消息给飞书，等待人类的审批！
      const { allowed, reason } = await globalApprovalMgr.waitForApproval(
        taskID,
        call.name,
        argsStr,
        bot.reporter(),
      )

      if (!allowed) {
        return { allowed: false, rejectReason: reason } // 拒绝，将理由传回给大模型
      }
      return { allowed: true, rejectReason: "" } // 同意，放行底层工具
    }

    // 没命中黑名单，直接 YOLO 放行
    return { allowed: true, rejectReason: "" }
  })

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
    log(
      `[Feishu][Webhook] ${req.method} ${pathname} from ${req.socket.remoteAddress ?? "?"}`,
    )
    void webhookHandler(req, res)
  })

  await new Promise<void>((resolve, reject) => {
    server.listen(port, () => {
      log(`🚀 ts-tiny-claw 飞书服务端已启动，正在监听 :${port} 端口`)
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
 * 同样挂载审批 Middleware，与 webhook 行为一致。
 */
async function runFeishuLongConnection(
  eng: AgentEngine,
  registry: Registry,
  workDir: string,
): Promise<void> {
  const sessionID = "test_command_intercept_001"
  const sess = globalSessionMgr.getOrCreate(sessionID, workDir)
  sess.append({ role: "user", content: "" })

  const bot = createFeishuBot(eng, sess)

  registry.use(async (_ctx, call) => {
    const argsStr =
      typeof call.arguments === "string"
        ? call.arguments
        : JSON.stringify(call.arguments ?? {})

    if (isDangerousCommand(call.name, argsStr)) {
      const taskID = call.id
      const { allowed, reason } = await globalApprovalMgr.waitForApproval(
        taskID,
        call.name,
        argsStr,
        bot.reporter(),
      )
      if (!allowed) {
        return { allowed: false, rejectReason: reason }
      }
      return { allowed: true, rejectReason: "" }
    }
    return { allowed: true, rejectReason: "" }
  })

  log("🚀 ts-tiny-claw 飞书长连接模式启动中…")
  log("   请在开放平台将订阅方式改为「使用长连接接收事件」")
  await bot.startLongConnection()
}

async function main() {
  const { mode, prompt } = parseArgs(process.argv.slice(2))

  if (mode === "session") {
    await runConcurrentSessionDemo()
    return
  }

  const workDir = ensureWorkDir()

  switch (mode) {
    case "trace": {
      await runTraceDemo(workDir)
      break
    }
    case "observability": {
      await runObservabilityDemo(workDir)
      break
    }
    case "subagent": {
      await runSubagentDemo(workDir)
      break
    }
    case "doom": {
      await runDoomLoopDemo(workDir)
      break
    }
    case "prompt": {
      if (!prompt.trim()) {
        console.log(
          '用法: npx tsx cmd/claw/main.ts -prompt "你的任务指令"',
        )
        process.exit(1)
      }
      const { eng } = createEngine(workDir, false, false)
      await runOneShotPrompt(eng, workDir, prompt.trim())
      break
    }
    case "repl": {
      const { eng } = createEngine(workDir, false, false)
      await runRepl(eng, workDir)
      break
    }
    case "webhook": {
      const { eng, registry } = createEngine(workDir, false, false)
      await runFeishuWebhook(eng, registry, workDir)
      break
    }
    case "ws": {
      const { eng, registry } = createEngine(workDir, false, false)
      await runFeishuLongConnection(eng, registry, workDir)
      break
    }
  }
}

try {
  await main()
} catch (err) {
  logError("启动失败:", err)
  process.exit(1)
}
