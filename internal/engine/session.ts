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

  /** 存放此 Session 中所有的用户输入、大模型回复和工具调用结果 */
  private history: Message[] = []

  constructor(id: string, workDir: string) {
    this.id = id
    this.workDir = workDir
    this.createdAt = new Date()
    this.updatedAt = new Date()
    this.history = []
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
    if (total <= limit || limit <= 0) {
      // 如果历史总量小于限制，或者不设限，全量返回 (需要深拷贝以防外部修改)
      return cloneMessages(this.history)
    }

    // 截取最近的 limit 条消息
    let res = cloneMessages(this.history.slice(total - limit))

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

    return res
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
