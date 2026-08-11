import { z } from "zod"

/** 消息角色：系统指令、用户输入、模型回复 */
export const RoleSchema = z.enum(["system", "user", "assistant"])
export type Role = z.infer<typeof RoleSchema>

/** 模型输出的工具调用请求 */
export const ToolCallSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** 工具入参，结构由各工具的 inputSchema 定义，延迟解析 */
  arguments: z.unknown(),
})
export type ToolCall = z.infer<typeof ToolCallSchema>

/** 对话消息，构成与大模型交互的上下文 */
export const MessageSchema = z.object({
  role: RoleSchema,
  content: z.string(),
  /** 模型请求调用的工具列表（仅 assistant 消息携带） */
  toolCalls: z.array(ToolCallSchema).optional(),
  /** 工具调用结果所对应的 ToolCall ID（仅工具结果消息携带） */
  toolCallId: z.string().optional(),
})
export type Message = z.infer<typeof MessageSchema>

/** 工具执行结果，回传给模型 */
export const ToolResultSchema = z.object({
  toolCallId: z.string(),
  output: z.string(),
  isError: z.boolean(),
})
export type ToolResult = z.infer<typeof ToolResultSchema>

/** 工具定义，用于向模型声明可调用的工具及其参数结构 */
export const ToolDefinitionSchema = z.object({
  name: z.string(),
  description: z.string(),
  /** JSON Schema 格式的入参描述 */
  inputSchema: z.record(z.string(), z.unknown()),
})
export type ToolDefinition = z.infer<typeof ToolDefinitionSchema>
