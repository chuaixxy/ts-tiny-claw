import type { ToolCall, ToolDefinition, ToolResult } from "../schema/message.ts"

/** Registry 定义了工具的注册与分发执行接口 */
export interface Registry {
  /** GetAvailableTools 返回当前系统挂载的所有可用工具的 Schema */
  getAvailableTools(): ToolDefinition[]

  /**
   * Execute 实际执行模型请求的工具，并返回结果。
   * ctx 对应 Go 的 context.Context，用于请求取消。
   */
  execute(ctx: AbortSignal | undefined, toolCall: ToolCall): Promise<ToolResult>
}
