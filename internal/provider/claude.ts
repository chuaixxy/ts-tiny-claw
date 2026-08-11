import Anthropic from "@anthropic-ai/sdk"
import type {
  ContentBlockParam,
  MessageParam,
  Tool,
  ToolUnion,
} from "@anthropic-ai/sdk/resources/messages"

import type { LLMProvider } from "./interface.ts"
import type { Message, ToolCall, ToolDefinition } from "../schema/message.ts"

/** 基于 Anthropic Messages API 的 Provider（可指向智谱等兼容端点） */
export class ClaudeProvider implements LLMProvider {
  private readonly client: Anthropic
  private readonly model: string

  constructor(client: Anthropic, model: string) {
    this.client = client
    this.model = model
  }

  async generate(
    ctx: AbortSignal | undefined,
    msgs: Message[],
    availableTools: ToolDefinition[] | undefined,
  ): Promise<Message> {
    const anthropicMsgs: MessageParam[] = []
    let systemPrompt = ""

    // 1. 消息翻译
    for (const msg of msgs) {
      switch (msg.role) {
        case "system":
          systemPrompt = msg.content
          break

        case "user":
          if (msg.toolCallId) {
            anthropicMsgs.push({
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: msg.toolCallId,
                  content: msg.content,
                  is_error: false,
                },
              ],
            })
          } else {
            anthropicMsgs.push({
              role: "user",
              content: [{ type: "text", text: msg.content }],
            })
          }
          break

        case "assistant": {
          const blocks: ContentBlockParam[] = []

          if (msg.content) {
            blocks.push({ type: "text", text: msg.content })
          }

          // 将历史工具调用转回 Claude 特有的 tool_use block
          for (const tc of msg.toolCalls ?? []) {
            blocks.push({
              type: "tool_use",
              id: tc.id,
              name: tc.name,
              input: normalizeToolInput(tc.arguments),
            })
          }

          if (blocks.length > 0) {
            anthropicMsgs.push({
              role: "assistant",
              content: blocks,
            })
          }
          break
        }
      }
    }

    // 2. 工具 Schema 翻译
    const anthropicTools: ToolUnion[] = (availableTools ?? []).map(toolDef => {
      const { properties, required } = extractInputSchema(toolDef.inputSchema)

      const inputSchema: Tool.InputSchema = {
        type: "object",
      }
      if (properties !== undefined) {
        inputSchema.properties = properties
      }
      if (required !== undefined) {
        inputSchema.required = required
      }

      const tool: Tool = {
        name: toolDef.name,
        description: toolDef.description,
        input_schema: inputSchema,
      }
      return tool
    })

    // 3. 构建请求并发送
    // 【慢思考机制支撑】仅当 availableTools 存在时才挂载 Tools
    const resp = await this.client.messages.create(
      {
        model: this.model,
        max_tokens: 4096,
        messages: anthropicMsgs,
        ...(systemPrompt
          ? { system: [{ type: "text" as const, text: systemPrompt }] }
          : {}),
        ...(anthropicTools.length > 0 ? { tools: anthropicTools } : {}),
      },
      { signal: ctx },
    )

    // 4. 反向解析
    let content = ""
    const toolCalls: ToolCall[] = []

    for (const block of resp.content) {
      switch (block.type) {
        case "text":
          content += block.text
          break
        case "tool_use":
          toolCalls.push({
            id: block.id,
            name: block.name,
            arguments: block.input,
          })
          break
      }
    }

    const resultMsg: Message = {
      role: "assistant",
      content,
    }

    if (toolCalls.length > 0) {
      resultMsg.toolCalls = toolCalls
    }

    return resultMsg
  }
}

/** 构造函数：基于 Anthropic SDK，指向智谱兼容端点 */
export function createZhipuClaudeProvider(model: string): ClaudeProvider {
  const apiKey = process.env.ZHIPU_API_KEY
  if (!apiKey) {
    throw new Error("请设置 ZHIPU_API_KEY 环境变量")
  }

  const baseURL = "https://open.bigmodel.cn/api/paas/v4/"

  return new ClaudeProvider(
    new Anthropic({
      apiKey,
      baseURL,
    }),
    model,
  )
}

function normalizeToolInput(args: unknown): Record<string, unknown> {
  if (args && typeof args === "object" && !Array.isArray(args)) {
    return args as Record<string, unknown>
  }

  if (typeof args === "string") {
    try {
      const parsed: unknown = JSON.parse(args)
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
    } catch {
      // fall through
    }
  }

  return {}
}

function extractInputSchema(inputSchema: Record<string, unknown>): {
  properties: unknown | undefined
  required: string[] | undefined
} {
  const properties = inputSchema.properties

  let required: string[] | undefined
  if (Array.isArray(inputSchema.required)) {
    required = inputSchema.required.filter((item): item is string => typeof item === "string")
  }

  return {
    properties: properties === undefined ? undefined : properties,
    required: required && required.length > 0 ? required : undefined,
  }
}
