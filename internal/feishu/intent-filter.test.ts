/* npx tsx internal/feishu/intent-filter.test.ts
 *
 * 意图闸门场景表：L1 硬规则（可单测）+ L2 期望标签（分类器契约，不打真实 API）。
 * 最终是否进 Main Loop = L1 已决则用 L1；L1=unsure 则看 L2。
 */
import {
  classToDecision,
  parseLabel,
  type IntentClass,
} from "./intent-classifier.ts"
import {
  decideIntent,
  fallbackUnsure,
  isBotMentioned,
  type IntentDecision,
} from "./intent-filter.ts"

type Case = {
  scene: string
  chatType: "group" | "p2p"
  text: string
  mentionedBot: boolean
  l1: IntentDecision
  /** L1=unsure 时分类器应给出的标签；L1 已决则填 null */
  l2: IntentClass | null
  /** 是否唤醒 Main Loop */
  wake: boolean
}

const cases: Case[] = [
  // ---------- 群聊：未 @ 一律不进引擎 ----------
  {
    scene: "群聊闲聊午饭",
    chatType: "group",
    text: "今天中午吃什么？",
    mentionedBot: false,
    l1: "drop",
    l2: null,
    wake: false,
  },
  {
    scene: "群聊未@问星期几",
    chatType: "group",
    text: "今天星期几",
    mentionedBot: false,
    l1: "drop",
    l2: null,
    wake: false,
  },
  {
    scene: "群聊未@但像排障（仍须@）",
    chatType: "group",
    text: "nginx 起不来了",
    mentionedBot: false,
    l1: "drop",
    l2: null,
    wake: false,
  },

  // ---------- 群聊：斜杠命令，不经 L2 ----------
  {
    scene: "群聊 /ops",
    chatType: "group",
    text: "/ops 查一下 nginx",
    mentionedBot: false,
    l1: "wake",
    l2: null,
    wake: true,
  },

  // ---------- 群聊：@ 了，话题交给 L2 ----------
  {
    scene: "群聊@问天气",
    chatType: "group",
    text: "帮我查一下今天天气",
    mentionedBot: true,
    l1: "unsure",
    l2: "chitchat",
    wake: false,
  },
  {
    scene: "群聊@问星期几",
    chatType: "group",
    text: "今天星期几",
    mentionedBot: true,
    l1: "unsure",
    l2: "chitchat",
    wake: false,
  },
  {
    scene: "群聊@排障 nginx",
    chatType: "group",
    text: "线上似乎出了点问题，帮我去服务器工作区里排查一下为什么 Nginx 起不来",
    mentionedBot: true,
    l1: "unsure",
    l2: "ops",
    wake: true,
  },
  {
    scene: "群聊@短确认",
    chatType: "group",
    text: "好的",
    mentionedBot: true,
    l1: "drop",
    l2: null,
    wake: false,
  },

  // ---------- 私聊：没有 @，短确认 L1 丢掉，其余交 L2 ----------
  {
    scene: "私聊好的",
    chatType: "p2p",
    text: "好的",
    mentionedBot: false,
    l1: "drop",
    l2: null,
    wake: false,
  },
  {
    scene: "私聊收到",
    chatType: "p2p",
    text: "收到",
    mentionedBot: false,
    l1: "drop",
    l2: null,
    wake: false,
  },
  {
    scene: "私聊哈哈",
    chatType: "p2p",
    text: "哈哈",
    mentionedBot: false,
    l1: "drop",
    l2: null,
    wake: false,
  },
  {
    scene: "私聊问星期几",
    chatType: "p2p",
    text: "今天星期几",
    mentionedBot: false,
    l1: "unsure",
    l2: "chitchat",
    wake: false,
  },
  {
    scene: "私聊问天气",
    chatType: "p2p",
    text: "北京今天天气怎么样",
    mentionedBot: false,
    l1: "unsure",
    l2: "chitchat",
    wake: false,
  },
  {
    scene: "私聊常识问答",
    chatType: "p2p",
    text: "1+1等于几",
    mentionedBot: false,
    l1: "unsure",
    l2: "chitchat",
    wake: false,
  },
  {
    scene: "私聊排障 nginx",
    chatType: "p2p",
    text: "线上 nginx 起不来，帮我排查并尝试修复",
    mentionedBot: false,
    l1: "unsure",
    l2: "ops",
    wake: true,
  },
  {
    scene: "私聊查 error.log",
    chatType: "p2p",
    text: "帮我看下 error.log 最后 50 行",
    mentionedBot: false,
    l1: "unsure",
    l2: "ops",
    wake: true,
  },
  {
    scene: "私聊 /agent",
    chatType: "p2p",
    text: "/agent 重启前先看配置",
    mentionedBot: false,
    l1: "wake",
    l2: null,
    wake: true,
  },

  // ---------- 审批口令不走意图闸门（Dispatcher 更早拦截），这里只作对照 ----------
]

function finalWake(c: Case): boolean {
  if (c.l1 === "wake") return true
  if (c.l1 === "drop") return false
  if (!c.l2) return fallbackUnsure() === "wake"
  return classToDecision(c.l2) === "wake"
}

let failed = 0

console.log("=== L1 硬规则 ===")
console.log(
  pad("场景", 22),
  pad("会话", 6),
  pad("@", 5),
  pad("L1", 8),
  pad("期望L1", 8),
)
for (const c of cases) {
  const got = decideIntent({
    chatType: c.chatType,
    text: c.text,
    mentionedBot: c.mentionedBot,
  })
  const ok = got === c.l1
  if (!ok) failed++
  console.log(
    mark(ok),
    pad(c.scene, 20),
    pad(c.chatType, 6),
    pad(c.mentionedBot ? "是" : "否", 5),
    pad(got, 8),
    pad(c.l1, 8),
    !ok ? `  text=${c.text}` : "",
  )
}

console.log("\n=== 全链路：L1 + 期望 L2 → 是否进 Main Loop ===")
console.log(
  pad("场景", 22),
  pad("L1", 8),
  pad("L2期望", 10),
  pad("唤醒?", 8),
)
for (const c of cases) {
  const wake = finalWake(c)
  const ok = wake === c.wake
  if (!ok) failed++
  console.log(
    mark(ok),
    pad(c.scene, 20),
    pad(c.l1, 8),
    pad(c.l2 ?? "—", 10),
    pad(wake ? "是" : "否", 8),
    !ok ? `  want=${c.wake}` : "",
  )
}

console.log("\n=== L2 标签解析（模型只应吐 ops/chitchat/ack）===")
const parseCases: [string, IntentClass | null][] = [
  ["ops", "ops"],
  ["chitchat", "chitchat"],
  ["ack", "ack"],
  ["OPS", "ops"],
  ["标签：chitchat", "chitchat"],
  ["我看是闲聊", null],
]
for (const [raw, want] of parseCases) {
  const got = parseLabel(raw)
  const ok = got === want
  if (!ok) failed++
  console.log(mark(ok), pad(JSON.stringify(raw), 16), "→", got, ok ? "" : ` want=${want}`)
}

console.log("\n=== @ 识别 ===")
const mentionCases: { scene: string; ok: boolean }[] = [
  {
    scene: "mentioned_type=app",
    ok: isBotMentioned([{ mentioned_type: "app", name: "Bot" }], {
      appId: "cli_x",
    }),
  },
  {
    scene: "app_id 对上",
    ok: isBotMentioned([{ id: { app_id: "cli_x" } }], { appId: "cli_x" }),
  },
  {
    scene: "@了别人",
    ok: !isBotMentioned([{ id: { app_id: "cli_other" }, name: "张三" }], {
      appId: "cli_x",
    }),
  },
  {
    scene: "无 mentions",
    ok: !isBotMentioned(undefined, { appId: "cli_x" }),
  },
]
for (const c of mentionCases) {
  if (!c.ok) failed++
  console.log(mark(c.ok), c.scene)
}

console.log(
  failed === 0
    ? `\n全部通过（${cases.length} 条场景）。L2 列是分类器契约，不打真实 API。`
    : `\n失败 ${failed} 条`,
)
process.exit(failed === 0 ? 0 : 1)

function mark(ok: boolean): string {
  return ok ? "OK " : "FAIL"
}

function pad(s: string, n: number): string {
  const w = [...s].length
  return s + " ".repeat(Math.max(1, n - w))
}
