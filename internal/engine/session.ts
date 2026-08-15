// internal/engine/session.ts
// 对应 Go: internal/engine/session.go

import type { Message } from "../schema/message.ts"

/**
 * Session 代表了一次持续的人机交互过程。它负责维护该会话的完整历史。
 *
 * 对应 Go: mu sync.RWMutex —— Node 单线程事件循环下，本类同步方法无 await 让出，
 * 天然互斥，不会发生 Go 式 Data Race；保留注释以便日后持久化异步化时加锁。
 */
export class Session {
  readonly id: string
  /** 该会话绑定的物理工作区 */
  readonly workDir: string
  readonly createdAt: Date
  updatedAt: Date

  // 【新增】用于统计该 Session 累计消耗的资源
  totalPromptTokens = 0
  totalCompletionTokens = 0
  totalCostCNY = 0

  /** 存放此 Session 中所有的用户输入、大模型回复和工具调用结果 */
  private history: Message[] = []

  constructor(id: string, workDir: string) {
    this.id = id
    this.workDir = workDir
    this.createdAt = new Date()
    this.updatedAt = new Date()
    this.history = []
  }

  /** RecordUsage 是一个给外部 Tracker 调用的辅助方法，用于累加账单 */
  recordUsage(prompt: number, completion: number, cost: number): void {
    // 对应 Go: s.mu.Lock() —— Node 同步方法无 await 让出，天然互斥
    this.totalPromptTokens += prompt
    this.totalCompletionTokens += completion
    this.totalCostCNY += cost
  }

  /** Append 线程安全地向 Session 中追加消息 */
  append(...msgs: Message[]): void {
    this.history.push(...msgs)
    this.updatedAt = new Date()

    // 【持久化预留点】：在真实的工业级实现中（如 Claude Code），
    // 我们会在这里将 s.history 以 JSONL 的格式 Append 到 workDir/.claw/sessions/xxx.jsonl 中。
    // this.saveToDisk()
  }

  /**
   * GetWorkingMemory 是驾驭工程的核心！
   * 它不返回全量历史，而是从后往前截取最近的 N 条消息，形成 Agent 的“短期工作记忆”。
   */
  getWorkingMemory(limit: number): Message[] {
    const total = this.history.length
    let res =
      total <= limit || limit <= 0
        ? cloneMessages(this.history)
        : cloneMessages(this.history.slice(total - limit))

    // 【驾驭防线】：大模型 API 强制要求历史消息的连续性！
    // 如果我们截断的第一条消息恰好是一个 ToolResult (RoleUser 且含有 ToolCallID)，
    // 但发出这个请求的 ToolCall 被我们截断抛弃了，大模型 API 会直接报 400 Bad Request。
    // 因此，如果切片首条属于“孤儿”工具响应，我们必须将其强行舍弃，顺延到下一条正常的 User/Assistant 消息。
    while (res.length > 0) {
      const first = res[0]!
      if (first.role === "user" && first.toolCallId) {
        res = res.slice(1)
      } else {
        break
      }
    }

    // assistant.tool_calls 必须紧跟对应 tool 结果；审批等待期间插入的普通 user
    // 会把配对打断（400 insufficient tool messages）。此处重排并补齐缺失结果。
    return repairToolCallContinuity(res)
  }
}

/** 工厂：对应 Go 的 NewSession */
export function createSession(id: string, workDir: string): Session {
  return new Session(id, workDir)
}

// ==========================================
// 全局 Session Manager: 用于多用户/多终端隔离
// ==========================================

export class SessionManager {
  private sessions = new Map<string, Session>()

  /** GetOrCreate 获取或创建一个会话 */
  getOrCreate(id: string, workDir: string): Session {
    const existing = this.sessions.get(id)
    if (existing) {
      return existing
    }
    const sess = createSession(id, workDir)
    this.sessions.set(id, sess)
    return sess
  }
}

/** 对应 Go: var GlobalSessionMgr = &SessionManager{...} */
export const globalSessionMgr = new SessionManager()

/** 浅拷贝消息列表，防止外部修改污染 Session 内部历史（对应 Go 的 copy） */
function cloneMessages(msgs: Message[]): Message[] {
  return msgs.map((m) => ({ ...m }))
}

/**
 * 保证每条带 toolCalls 的 assistant 后面紧跟齐全的 tool 结果。
 * 插在中间的普通 user（例如把 approve 打成 pprove）会被挪到结果之后。
 */
function repairToolCallContinuity(msgs: Message[]): Message[] {
  const out: Message[] = []
  let i = 0
  while (i < msgs.length) {
    const msg = msgs[i]!
    const calls = msg.role === "assistant" ? msg.toolCalls : undefined
    if (!calls || calls.length === 0) {
      out.push(msg)
      i++
      continue
    }

    out.push(msg)
    i++
    const needed = new Set(calls.map((tc) => tc.id))
    const results: Message[] = []
    const extras: Message[] = []

    while (i < msgs.length && needed.size > 0) {
      const next = msgs[i]!
      if (next.role === "user" && next.toolCallId && needed.has(next.toolCallId)) {
        results.push(next)
        needed.delete(next.toolCallId)
        i++
        continue
      }
      if (next.role === "user" && next.toolCallId) {
        i++ // 孤儿 tool result
        continue
      }
      if (next.role === "assistant") break
      extras.push(next)
      i++
    }

    for (const id of needed) {
      results.push({
        role: "user",
        content: "工具执行被中断，未返回结果。",
        toolCallId: id,
      })
    }
    out.push(...results, ...extras)
  }
  return out
}
