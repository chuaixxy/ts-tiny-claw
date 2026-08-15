// internal/feishu/intent-classifier.ts
// Dispatcher 入站 L2：仅对 L1 = unsure 的句子做一次无工具短分类。
// 不写 Session、不调工具；超时或解析失败由调用方回退 fallbackUnsure。

import { log, warn } from "../log/log.ts"
import { createOpenAIProvider } from "../provider/openai.ts"
import type { LLMProvider } from "../provider/interface.ts"

export type IntentClass = "ops" | "chitchat" | "ack"

const CLASSIFY_TIMEOUT_MS = 2500

const SYSTEM = `你是 AgentOps 入站意图分类器。用户消息来自飞书群或私聊。
只根据这一句话判断是否需要唤醒会使用 bash/改配置/查日志的运维 Agent。
只输出三个标签之一（小写、无其它字）：
- ops：排障、查日志、改 nginx/配置、重启服务、修代码、看报错等需要动手的任务
- ack：好的、收到、谢谢、表情等确认
- chitchat：闲聊。包括天气、星期几、吃饭、笑话、翻译、常识问答等与运维无关的问题`

let provider: LLMProvider | null = null

function getProvider(): LLMProvider | null {
  if (provider) return provider
  try {
    const model =
      process.env.LLM_INTENT_MODEL?.trim() ||
      process.env.LLM_MODEL ||
      "glm-4.5-air"
    provider = createOpenAIProvider(model)
    return provider
  } catch (err) {
    warn("[Intent] 无法初始化分类模型:", err)
    return null
  }
}

export function parseLabel(raw: string): IntentClass | null {
  const token = raw.trim().toLowerCase().replace(/[^a-z]/g, "")
  if (token === "ops" || token === "chitchat" || token === "ack") return token
  if (/\bops\b/.test(raw.toLowerCase())) return "ops"
  if (/\back\b/.test(raw.toLowerCase())) return "ack"
  if (/\bchitchat\b/.test(raw.toLowerCase())) return "chitchat"
  return null
}

/**
 * 对 unsure 文本做一次短分类。超时 800ms。
 * 失败返回 null，由 Dispatcher 走群 drop / 私 wake。
 */
export async function classifyIntent(text: string): Promise<IntentClass | null> {
  const llm = getProvider()
  if (!llm) return null

  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), CLASSIFY_TIMEOUT_MS)
  try {
    const msg = await llm.generate(
      ac.signal,
      [
        { role: "system", content: SYSTEM },
        { role: "user", content: text.slice(0, 500) },
      ],
      undefined,
    )
    const label = parseLabel(msg.content ?? "")
    if (!label) {
      log(`[Intent] L2 无法解析标签: ${(msg.content ?? "").slice(0, 80)}`)
    }
    return label
  } catch (err) {
    const aborted = ac.signal.aborted
    log(
      `[Intent] L2 分类失败${aborted ? "（超时）" : ""}:`,
      err instanceof Error ? err.message : err,
    )
    return null
  } finally {
    clearTimeout(timer)
  }
}

export function classToDecision(label: IntentClass): "wake" | "drop" {
  return label === "ops" ? "wake" : "drop"
}

/** 被叫到却判定为非运维时的固定回复，不进 Session、不调工具 */
export function declineReply(reason: "ack" | "chitchat" | "generic"): string {
  if (reason === "ack") {
    return "收到。需要排查服务、查日志或改配置时再叫我。"
  }
  if (reason === "chitchat") {
    return "我是运维小助手，只处理排障、日志和配置相关的事。闲聊这边不展开～有线上问题直接说就行。"
  }
  return "这个问题不像运维排障，我先不调用工具。需要查服务或改配置再说一声。"
}
