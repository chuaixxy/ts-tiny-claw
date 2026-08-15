// internal/feishu/bot.ts
// 对应 Go: internal/feishu/bot.go

import * as lark from "@larksuiteoapi/node-sdk"
import type { Client, EventDispatcher } from "@larksuiteoapi/node-sdk"

import type { AgentEngine } from "../engine/loop.ts"
import { createMultiReporter, type Reporter } from "../engine/reporter.ts"
import { globalSessionMgr, type Session } from "../engine/session.ts"
import { createTerminalReporter } from "../engine/terminal-reporter.ts"
import { error as logError, log } from "../log/log.ts"
import {
  asTraceContext,
  type TraceContext,
} from "../observability/trace.ts"
import { globalApprovalMgr } from "./approval.ts"

/** 飞书 im.message.receive_v1 事件的最小载荷（Node SDK 回调 data 形状） */
interface FeishuMessageEvent {
  sender?: {
    sender_type?: string
  }
  message: {
    chat_id: string
    message_type?: string
    content: string
  }
}

// ==========================================
// 1. Context 传递机制：解决并发 Reporter 的提取
// 对应 Go: reporterKey / ContextWithReporter / ReporterFromContext
// ==========================================

/** AgentEngineFactory 允许每次收到消息时，根据 Session 动态创建引擎 */
export type AgentEngineFactory = (session: Session) => AgentEngine

/**
 * 将专属 Reporter 封入 TraceContext（对应 Go context.WithValue(reporterKey{})）。
 * startSpan 会把 reporter 拷到子 Context，Middleware 才能取到。
 */
export function contextWithReporter(
  ctx: TraceContext | undefined,
  reporter: Reporter,
): TraceContext {
  const next: TraceContext = { reporter }
  if (ctx?.signal) next.signal = ctx.signal
  if (ctx?.span) next.span = ctx.span
  return next
}

/**
 * 供底层 Middleware 提取当前会话的 Reporter，发送审批卡片。
 * 对应 Go: ReporterFromContext(ctx)。
 */
export function reporterFromContext(
  ctx: AbortSignal | TraceContext | undefined,
): Reporter | undefined {
  const stored = asTraceContext(ctx)?.reporter
  if (stored && isReporter(stored)) return stored
  return undefined
}

function isReporter(v: unknown): v is Reporter {
  return (
    typeof v === "object" &&
    v !== null &&
    "onThinking" in v &&
    "onToolCall" in v &&
    "onToolResult" in v &&
    "onMessage" in v
  )
}

// ==========================================
// 2. 飞书 Bot 核心调度器
// ==========================================

/** FeishuBot 封装了飞书机器人的配置与核心业务流 */
export class FeishuBot {
  readonly client: Client
  readonly appId: string
  readonly appSecret: string
  /** 保存从入口传来的工作区路径 */
  private readonly workDir: string
  /** 替换掉原来的单一 engine / session 引用 */
  private readonly factory: AgentEngineFactory
  /** 同一 chat 正在跑 Agent（含等待审批）时，禁止再开一条引擎 */
  private readonly runningChats = new Set<string>()

  constructor(
    factory: AgentEngineFactory,
    workDir: string,
    opts?: { appId?: string; appSecret?: string },
  ) {
    const appId = opts?.appId ?? process.env.FEISHU_APP_ID ?? ""
    const appSecret = opts?.appSecret ?? process.env.FEISHU_APP_SECRET ?? ""

    if (!appId || !appSecret) {
      // 对应 Go: log.Fatal("请设置 FEISHU_APP_ID 和 FEISHU_APP_SECRET")
      throw new Error("请设置 FEISHU_APP_ID 和 FEISHU_APP_SECRET")
    }

    this.appId = appId
    this.appSecret = appSecret
    this.workDir = workDir
    this.factory = factory

    // 实例化飞书官方客户端
    this.client = new lark.Client({
      appId,
      appSecret,
      appType: lark.AppType.SelfBuild,
      domain: lark.Domain.Feishu,
    })
  }

  /**
   * GetEventDispatcher 用于注册到 HTTP 服务器，处理来自飞书的 POST 事件。
   *
   * 用法（对应 Go 把 dispatcher 挂到 HTTP Server）：
   *   import http from "node:http"
   *   import * as lark from "@larksuiteoapi/node-sdk"
   *   server.on("request", lark.adaptDefault("/webhook/event", bot.getEventDispatcher()))
   */
  getEventDispatcher(): EventDispatcher {
    const encryptKey = process.env.FEISHU_ENCRYPT_KEY
    // Go 使用 FEISHU_VERIFY_TOKEN；亦兼容 FEISHU_VERIFICATION_TOKEN
    const verificationToken =
      process.env.FEISHU_VERIFY_TOKEN ?? process.env.FEISHU_VERIFICATION_TOKEN

    const dispatcherOpts: {
      encryptKey?: string
      verificationToken?: string
    } = {}
    if (encryptKey) dispatcherOpts.encryptKey = encryptKey
    if (verificationToken) dispatcherOpts.verificationToken = verificationToken

    // 使用官方 SDK 构建调度器，监听 "接收消息" 事件
    return new lark.EventDispatcher(dispatcherOpts).register({
      "im.message.receive_v1": async (data) => {
        const event = data as FeishuMessageEvent

        // 忽略机器人自己的消息，避免回环
        if (event.sender?.sender_type === "app") {
          return
        }

        // 由于飞书消息体是 JSON，我们需要粗略地提取其中的文本内容。
        // 这里简单处理：去掉开头结尾的特殊转义字符和引用的机器人名字。
        // （Node 侧优先 JSON.parse；失败时再退化为与 Go 相同的 TrimPrefix/TrimSuffix 裁剪。）
        const contentStr = extractText(event)

        const chatId = event.message.chat_id
        if (!contentStr.trim()) {
          log(`[Feishu] 会话 ${chatId} 消息无文本内容，已忽略`)
          return
        }

        log(`[Feishu] 收到会话 ${chatId} 消息: ${contentStr}`)

        // 拦截人工审批口令（含 pprove 等拼写误差，只要带上挂起的 TaskID）
        const approval = parseApprovalCommand(
          contentStr,
          globalApprovalMgr.pendingTaskIDs(),
        )
        if (approval) {
          globalApprovalMgr.resolveApproval(
            approval.taskID,
            approval.allowed,
            approval.allowed
              ? "人类管理员已批准操作"
              : "人类管理员认为该操作存在极高风险，已无情拒绝",
          )
          log(
            `[Feishu] 会话 ${chatId}: ${approval.allowed ? "✅ 已为您批准" : "🚫 已拒绝"}任务 ${approval.taskID}`,
          )
          return undefined
        }

        // 审批挂起期间再来一条普通消息，绝不能新开引擎：
        // 否则会往未完成的 tool_calls 后面插入 user，下一轮 LLM 直接 400。
        if (this.runningChats.has(chatId)) {
          const pending = globalApprovalMgr.pendingTaskIDs()
          const hint =
            pending.length > 0
              ? `当前任务正在等待审批，请回复：\napprove ${pending[0]}\n或\nreject ${pending[0]}`
              : "当前会话已有任务在执行，请稍候。"
          log(`[Feishu] 会话 ${chatId} 忙碌中，忽略新对话: ${contentStr}`)
          void new FeishuReporter(this.client, chatId).sendMsg(hint)
          return undefined
        }

        // 如果不是审批命令，则是正常对话，启动一个新的 Agent 任务去处理
        //
        // 【驾驭并发】：收到消息后，绝不能阻塞 HTTP 回调。
        // Go: go b.handleAgentRun(chatId, contentStr)
        // Node: void this.handleAgentRun(...) fire-and-forget
        void this.handleAgentRun(chatId, contentStr)

        return undefined
      },
      "im.message.message_read_v1": async () => {
        // 消息已读事件，静默忽略（避免日志干扰）
        return undefined
      },
    })
  }

  /** handleAgentRun 是连接飞书与底层引擎的桥梁 */
  private async handleAgentRun(chatId: string, prompt: string): Promise<void> {
    this.runningChats.add(chatId)
    try {
      await this.runAgentOnce(chatId, prompt)
    } finally {
      this.runningChats.delete(chatId)
    }
  }

  private async runAgentOnce(chatId: string, prompt: string): Promise<void> {
    // 为当前并发请求实例化一个专属的 Reporter（不再写入 this.r）
    const feishuReporter = new FeishuReporter(this.client, chatId)
    // 飞书回帖 + 终端旁路：本地也能看到 🤖 / 🛠️ 日志
    const reporter = createMultiReporter(
      createTerminalReporter(),
      feishuReporter,
    )

    // 1. 获取物理隔离的 Session（以 chatId 为键，避免多群串台）
    const sess = globalSessionMgr.getOrCreate(chatId, this.workDir)
    sess.append({ role: "user", content: prompt })

    // 2. 通过工厂模式，为当前会话生成挂好专属 CostTracker 的新引擎
    const eng = this.factory(sess)

    // 3. 【驾驭核心】：将专属 Reporter 塞入 Context 并传给引擎
    //    Middleware 用 reporterFromContext 取，而不是 bot.reporter()
    const runCtx = contextWithReporter(undefined, feishuReporter)

    log(`\n>>> 🙋‍♂️ [Session ${sess.id} / chat ${chatId}]: ${prompt}`)

    try {
      await eng.run(runCtx, sess, reporter)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logError("[Feishu] Agent 运行崩溃:", err)
      await feishuReporter.sendMsg(`❌ Agent 运行崩溃: ${msg}`)
    }
  }

  /**
   * 长连接模式接收事件（不需要公网 Webhook URL / EventListener HTTP）。
   *
   * 开放平台「事件配置」选「使用长连接接收事件」，本地只要能访问公网即可。
   * 测试阶段无需内网穿透；鉴权只在建连时做一次，后续事件明文推送。
   * @see https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/event-subscription-guide/long-connection-mode
   */
  async startLongConnection(): Promise<void> {
    const wsClient = new lark.WSClient({
      appId: this.appId,
      appSecret: this.appSecret,
      domain: lark.Domain.Feishu,
      loggerLevel: lark.LoggerLevel.info,
      onReady: () => {
        log("[Feishu] 长连接已就绪，等待 im.message.receive_v1…")
      },
      onError: (err) => {
        logError("[Feishu] 长连接失败", err)
      },
      onReconnecting: () => {
        log("[Feishu] 长连接重连中…")
      },
      onReconnected: () => {
        log("[Feishu] 长连接已重连")
      },
    })

    // SDK 的 start() 发起连接后即 resolve；再用永不 settle 的 Promise 挂住进程
    await wsClient.start({ eventDispatcher: this.getEventDispatcher() })
    await new Promise<void>(() => {
      /* hang until process exit */
    })
  }
}

/** 工厂：对应 Go 的 NewFeishuBotWithFactory(factory) */
export function createFeishuBot(
  factory: AgentEngineFactory,
  workDir: string,
): FeishuBot {
  return new FeishuBot(factory, workDir)
}

/**
 * 从飞书消息 content 提取纯文本。
 * 对应 Go 里对 Content 的 TrimPrefix(`{"text":"`) / TrimSuffix(`"}`) 粗解析；
 * Node 优先 JSON.parse，失败时再走相同的字符串裁剪。
 */
function extractText(event: FeishuMessageEvent): string {
  const raw = event.message.content ?? ""
  const msgType = event.message.message_type ?? "text"

  if (msgType === "text") {
    try {
      const parsed = JSON.parse(raw) as { text?: string }
      return (parsed.text ?? "").trim()
    } catch {
      // 对应 Go:
      //   contentStr = strings.TrimPrefix(contentStr, `{"text":"`)
      //   contentStr = strings.TrimSuffix(contentStr, `"}`)
      return raw
        .replace(/^\{"text":"/, "")
        .replace(/"\}$/, "")
        .trim()
    }
  }

  return ""
}

/**
 * 解析人工审批口令。
 * 标准：`approve <taskID>` / `reject <taskID>`
 * 容错：消息里带了正在挂起的 TaskID（如把 approve 打成 pprove）也视为审批。
 */
function parseApprovalCommand(
  text: string,
  pendingIDs: string[],
): { allowed: boolean; taskID: string } | null {
  const trimmed = text.trim()
  const exact = /^(approve|reject)\s+(\S+)/i.exec(trimmed)
  if (exact) {
    const action = exact[1]!.toLowerCase()
    return { allowed: action === "approve", taskID: exact[2]! }
  }

  for (const taskID of pendingIDs) {
    if (!trimmed.includes(taskID)) continue
    if (/\breject\b|拒绝|deny/i.test(trimmed)) {
      return { allowed: false, taskID }
    }
    if (/a?pprove|批准|同意/i.test(trimmed)) {
      return { allowed: true, taskID }
    }
  }
  return null
}

// ==========================================
// FeishuReporter: 将引擎的输出格式化后发给飞书
// ==========================================

export class FeishuReporter implements Reporter {
  private readonly client: Client
  private readonly chatId: string

  constructor(client: Client, chatId: string) {
    this.client = client
    this.chatId = chatId
  }

  /** sendMsg 封装了调用飞书 OpenAPI 发送卡片/文本的操作 */
  async sendMsg(text: string): Promise<void> {
    // 构建文本消息内容
    // 对应 Go:
    //   textContent := map[string]string{"text": text}
    //   contentBytes, _ := json.Marshal(textContent)
    try {
      const res = await this.client.im.v1.message.create({
        params: {
          // ReceiveIdTypeChatId
          receive_id_type: "chat_id",
        },
        data: {
          receive_id: this.chatId,
          // MsgTypeText
          msg_type: "text",
          content: JSON.stringify({ text }),
        },
      })
      if (res.code !== 0) {
        logError(`[Feishu] 发消息失败 code=${res.code} msg=${res.msg ?? ""}`)
      }
    } catch (err) {
      // Go 里 _, _ = client.Im.Message.Create(...) 忽略错误；Node 侧至少打日志便于排查
      logError("[Feishu] 发消息异常:", err)
    }
  }

  async onThinking(_ctx: AbortSignal | undefined): Promise<void> {
    // 仅发一个轻量级提示，避免飞书刷屏
    await this.sendMsg("🤔 模型正在慢思考 (Thinking)...")
  }

  async onToolCall(
    _ctx: AbortSignal | undefined,
    toolName: string,
    args: string,
  ): Promise<void> {
    await this.sendMsg(`🛠️ **正在执行工具**：\`${toolName}\`\n参数：\`${args}\``)
  }

  async onToolResult(
    _ctx: AbortSignal | undefined,
    toolName: string,
    result: string,
    isError: boolean,
  ): Promise<void> {
    if (isError) {
      await this.sendMsg(`⚠️ **执行报错** (${toolName})：\n${result}`)
    } else {
      // 成功时仅汇报成功，不刷全量日志
      await this.sendMsg(`✅ **执行成功** (${toolName})`)
    }
  }

  async onMessage(
    _ctx: AbortSignal | undefined,
    content: string,
  ): Promise<void> {
    // 将模型最终的纯文本回答发给用户
    await this.sendMsg(content)
  }
}

// 编译时类型检查：确保 FeishuReporter 实现了 Reporter 接口
// 对应 Go: var _ engine.Reporter = (*FeishuReporter)(nil)
const _feishuReporterTypeCheck: Reporter = null as unknown as FeishuReporter
void _feishuReporterTypeCheck
