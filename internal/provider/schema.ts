/** 消息角色：系统指令、用户输入、模型回复 */
export type Role = "system" | "user" | "assistant"

/** 对话消息，构成与大模型交互的上下文 */
export interface Message {
  role: Role
  content: string
  /** 模型请求调用的工具列表（仅 assistant 消息携带） */
  toolCalls?: ToolCall[]
  /** 工具调用结果所对应的 ToolCall ID（仅工具结果消息携带） */
  toolCallId?: string
}

/** 模型输出的工具调用请求 */
export interface ToolCall {
  id: string
  name: string
  /** 工具入参，结构由各工具的 inputSchema 定义，延迟解析 */
  arguments: unknown
}

/** 工具执行结果，回传给模型 */
export interface ToolResult {
  toolCallId: string
  output: string
  isError: boolean
}

/** 工具定义，用于向模型声明可调用的工具及其参数结构 */
export interface ToolDefinition {
  name: string
  description: string
  /** JSON Schema 格式的入参描述 */
  inputSchema: Record<string, unknown>
}
