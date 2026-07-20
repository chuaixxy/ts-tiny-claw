import type { Message, ToolDefinition } from "./schema"

/** 与大模型通信的统一契约，所有厂商实现此接口 */
export interface LLMProvider {
  /** 接收当前的上下文历史、可用工具列表，并发起一次大模型推理 */
  generate(messages: Message[], availableTools: ToolDefinition[]): Promise<Message>
}
