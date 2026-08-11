import type { Message, ToolDefinition } from "../schema/message.ts"

/** LLMProvider 定义了与大模型通信的统一契约 */
export interface LLMProvider {
  /**
   * Generate 接收当前的上下文历史、可用工具列表，并发起一次大模型推理。
   * ctx 对应 Go 的 context.Context，用于请求取消。
   */
  generate(
    ctx: AbortSignal | undefined,
    messages: Message[],
    availableTools: ToolDefinition[] | undefined,
  ): Promise<Message>
}
