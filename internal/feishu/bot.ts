// internal/feishu/bot.ts
// 对应 Go: internal/feishu/bot.go

import * as lark from "@larksuiteoapi/node-sdk"
import type { Client, EventDispatcher } from "@larksuiteoapi/node-sdk"

import type { AgentEngine } from "../engine/loop.ts"
import { createMultiReporter, type Reporter } from "../engine/reporter.ts"
import { globalSessionMgr } from "../engine/session.ts"
import { createTerminalReporter } from "../engine/terminal-reporter.ts"
import { error as logError, log } from "../log/log.ts"

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

/** FeishuBot 封装了飞书机器人的配置与核心业务流 */
export class FeishuBot {
  readonly client: Client
  readonly appId: string
  readonly appSecret: string
  /** 持有核心引擎引用 */
  private readonly engine: AgentEngine
  /** Session 默认工作区（讲义同款：工具仍绑定 Registry 构造时的目录） */
  private readonly workDir: string

  constructor(
    engine: AgentEngine,
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
    this.engine = engine
    this.workDir = workDir

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

        // 【驾驭并发】：收到消息后，绝不能阻塞 HTTP 回调。
        // 我们要为每个请求开启一个独立的任务跑 Agent！
        //
        // Go 使用 go 关键字拉起 Goroutine：
        //   go b.handleAgentRun(chatId, contentStr)
        // 当你在飞书群里同时发了三条指令，服务器瞬间会拉起三个完全独立的
        // ReAct 循环，它们各自思考，各干各的，最后各自回传给对应的飞书聊天窗口。
        //
        // Node 没有 go 协程，等价写法是：不 await 这个 async 方法（fire-and-forget）。
        // void this.handleAgentRun(...) 会立刻返回，Webhook 回调不被阻塞；
        // 事件循环里可以同时挂着多个 engine.run Promise——三条消息 = 三个独立的
        // ReAct 循环 + 各自绑定 chatId 的 FeishuReporter，语义与 Go 的 go 一致。
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
    // 飞书回帖 + 终端旁路：本地也能看到 🤖 / 🛠️ 日志
    const feishuReporter = new FeishuReporter(this.client, chatId)
    const reporter = createMultiReporter(
      createTerminalReporter(),
      feishuReporter,
    )

    // 按 chatId 隔离 Session（历史物理隔离；WorkDir 与 Registry 工具目录一致即可）
    const session = globalSessionMgr.getOrCreate(chatId, this.workDir)
    session.append({ role: "user", content: prompt })

    log(`\n>>> 🙋‍♂️ [Session ${chatId}]: ${prompt}`)

    // 启动引擎！
    try {
      await this.engine.run(undefined, session, reporter)
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

/** 工厂：对应 Go 的 NewFeishuBot */
export function createFeishuBot(
  engine: AgentEngine,
  workDir: string,
): FeishuBot {
  return new FeishuBot(engine, workDir)
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
