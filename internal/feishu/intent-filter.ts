// internal/feishu/intent-filter.ts
// Dispatcher 入站 L1：只做免费、可解释的硬规则（空消息、@、斜杠、短确认）。
// 内容是不是运维意图，交给 L2 轻量模型，不在这里堆闲聊关键词。

export type IntentDecision = "wake" | "drop" | "unsure"

export interface FeishuMention {
  key?: string
  name?: string
  mentioned_type?: string
  id?: {
    open_id?: string
    app_id?: string
  }
}

export interface DecideIntentInput {
  chatType: string
  text: string
  mentionedBot: boolean
}

const SLASH_WAKE = /^\/(ops|agent|claw)\b/i

const ACK_EXACT = new Set([
  "好的",
  "好",
  "收到",
  "谢谢",
  "感谢",
  "哈哈",
  "嗯",
  "嗯嗯",
  "哦",
  "噢",
  "行",
  "可以",
  "在吗",
  "ok",
  "okay",
  "thanks",
  "thx",
  "👍",
  "👌",
  "😄",
  "😂",
])

/** 无 chat_type 时按群聊严进 */
export function normalizeChatType(chatType: string | undefined): "group" | "p2p" {
  const t = (chatType ?? "").toLowerCase()
  if (t === "p2p" || t === "p2p_chat") return "p2p"
  return "group"
}

/** 用 mentions 对齐本应用，不要只靠文本里的 @名字 */
export function isBotMentioned(
  mentions: FeishuMention[] | undefined,
  identity: { appId: string; openId?: string; name?: string },
): boolean {
  if (!mentions?.length) return false
  const openId = identity.openId?.trim() ?? ""
  const name = identity.name?.trim() ?? ""
  return mentions.some((m) => {
    if (m.mentioned_type === "app" || m.mentioned_type === "application") {
      return true
    }
    if (m.id?.app_id && m.id.app_id === identity.appId) return true
    if (openId && m.id?.open_id === openId) return true
    if (name && m.name === name) return true
    return false
  })
}

/**
 * L1 只回答「这是不是一次对 Bot 的请求」，不判断话题。
 * - 群聊未 @ → drop（社会约定）
 * - 斜杠命令 → wake
 * - 极短确认语 → drop
 * - 其余 → unsure，交给 L2 分类
 */
export function decideIntent(input: DecideIntentInput): IntentDecision {
  const text = input.text.trim()
  if (!text) return "drop"
  if (SLASH_WAKE.test(text)) return "wake"

  const chatType = normalizeChatType(input.chatType)
  if (chatType === "group" && !input.mentionedBot) {
    return "drop"
  }

  const compact = text.replace(/[\s,.!！?？。，~]+/g, "")
  if (compact.length <= 8 && ACK_EXACT.has(compact.toLowerCase())) {
    return "drop"
  }

  return "unsure"
}

/** L2 失败或被关闭：不跑昂贵 Main Loop */
export function fallbackUnsure(
  _chatType?: string,
  _mentionedBot?: boolean,
): IntentDecision {
  return "drop"
}

/** 群里没 @ 保持静默；私聊或已 @ 时 drop 也要回一句，避免像没反应 */
export function shouldReplyOnDrop(
  chatType: string,
  mentionedBot: boolean,
): boolean {
  return normalizeChatType(chatType) === "p2p" || mentionedBot
}

/** 默认开启 L2；FEISHU_INTENT_LLM=0 可关掉 */
export function isIntentLlmEnabled(): boolean {
  const v = process.env.FEISHU_INTENT_LLM?.trim().toLowerCase()
  if (v === "0" || v === "false" || v === "no") return false
  return true
}
