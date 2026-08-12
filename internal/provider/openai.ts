import OpenAI from "openai"
import type {
  ChatCompletionAssistantMessageParam,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions"

import type { LLMProvider } from "./interface.ts"
import type { Message, ToolCall, ToolDefinition } from "../schema/message.ts"

/** 基于 OpenAI 兼容协议的 Provider（可指向智谱等兼容端点） */
export class OpenAIProvider implements LLMProvider {
  private readonly client: OpenAI
  private readonly model: string

  constructor(client: OpenAI, model: string) {
    this.client = client
    this.model = model
  }

  async generate(
    ctx: AbortSignal | undefined,
    msgs: Message[],
    availableTools: ToolDefinition[] | undefined,
  ): Promise<Message> {
    // 1. 翻译上下文消息
    const openaiMsgs: ChatCompletionMessageParam[] = []

    for (const msg of msgs) {
      switch (msg.role) {
        case "system":
          openaiMsgs.push({ role: "system", content: msg.content })
          break

        case "user":
          if (msg.toolCallId) {
            openaiMsgs.push({
              role: "tool",
              content: msg.content,
              tool_call_id: msg.toolCallId,
            })
          } else {
            openaiMsgs.push({ role: "user", content: msg.content })
          }
          break

        case "assistant": {
          const astParam: ChatCompletionAssistantMessageParam = {
            role: "assistant",
          }

          if (msg.content) {
            astParam.content = msg.content
          }

          // 【重要】如果历史包含 ToolCalls，必须原样放回，以维系大模型的逻辑链
          if (msg.toolCalls && msg.toolCalls.length > 0) {
            astParam.tool_calls = msg.toolCalls.map(tc => ({
              id: tc.id,
              type: "function" as const,
              function: {
                name: tc.name,
                arguments: toolArgsToString(tc.arguments),
              },
            }))
          }

          openaiMsgs.push(astParam)
          break
        }
      }
    }

    // 2. 翻译工具定义
    const openaiTools: ChatCompletionTool[] = (availableTools ?? []).map(toolDef => ({
      type: "function" as const,
      function: {
        name: toolDef.name,
        description: toolDef.description,
        parameters: toolDef.inputSchema,
      },
    }))

    // 3. 构建请求并发送
    // 【慢思考机制支撑】仅当 availableTools 存在时才挂载 Tools
    const resp = await this.client.chat.completions.create(
      {
        model: this.model,
        messages: openaiMsgs,
        ...(openaiTools.length > 0 ? { tools: openaiTools } : {}),
      },
      { signal: ctx },
    )

    if (!resp?.choices || resp.choices.length === 0) {
      throw new Error(
        `API 未返回有效 choices（请检查 LLM_BASE_URL 是否包含 /v1 等版本前缀）。原始响应: ${JSON.stringify(resp).slice(0, 500)}`,
      )
    }

    // 4. 将 API Response 反向翻译为内部 Message
    const choice = resp.choices[0]!.message
    const toolCalls: ToolCall[] = []

    for (const tc of choice.tool_calls ?? []) {
      if (tc.type === "function") {
        toolCalls.push({
          id: tc.id,
          name: tc.function.name,
          arguments: parseToolArgs(tc.function.arguments),
        })
      }
    }

    const resultMsg: Message = {
      role: "assistant",
      content: choice.content ?? "",
    }

    if (toolCalls.length > 0) {
      resultMsg.toolCalls = toolCalls
    }

    return resultMsg
  }
}

export type CompatibleProviderOptions = {
  apiKey?: string
  /** OpenAI 兼容端点，默认读 LLM_BASE_URL（智谱 / DeepSeek / 豆包等均可） */
  baseURL?: string
}

/** 构造函数：基于 OpenAI SDK，指向任意 OpenAI 兼容端点 */
export function createOpenAIProvider(
  model: string,
  options?: CompatibleProviderOptions,
): OpenAIProvider {
  const apiKey = options?.apiKey ?? process.env.LLM_API_KEY
  if (!apiKey) {
    throw new Error("请设置 LLM_API_KEY 环境变量")
  }

  const baseURL = options?.baseURL ?? process.env.LLM_BASE_URL
  if (!baseURL) {
    throw new Error("请设置 LLM_BASE_URL 环境变量")
  }

  return new OpenAIProvider(
    new OpenAI({
      apiKey,
      baseURL,
    }),
    model,
  )
}

function toolArgsToString(args: unknown): string {
  if (typeof args === "string") return args
  return JSON.stringify(args ?? {})
}

function parseToolArgs(args: string): unknown {
  try {
    return JSON.parse(args)
  } catch {
    return args
  }
}
