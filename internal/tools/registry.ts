import type { ToolCall, ToolDefinition, ToolResult } from "../schema/message.ts"

/**
 * BaseTool 是所有具体工具必须实现的通用接口。
 * 每个工具必须能说出自己的名字、描述，给出严谨的参数要求（JSON Schema），
 * 并接收一段原始的 JSON 字节去执行具体逻辑。
 */
export interface BaseTool {
  /** 返回工具的全局唯一名称 (大模型通过这个名字调用它) */
  name(): string

  /** 返回用于提交给大模型的工具元信息和参数 JSON Schema */
  definition(): ToolDefinition

  /**
   * 接收大模型吐出的 JSON 参数，执行具体业务逻辑。
   * 注意：参数对应 Go 的 json.RawMessage（原始 JSON 字节），反序列化由各个具体工具内部自行处理。
   * ctx 对应 Go 的 context.Context，用于请求取消。
   */
  execute(ctx: AbortSignal | undefined, args: Uint8Array): Promise<string>
}

/** Registry 定义了工具的注册与分发接口 */
export interface Registry {
  /** 挂载一个新的工具到系统中 */
  register(tool: BaseTool): void

  /** 返回当前系统挂载的所有工具的 Schema，供 Main Loop 交给 Provider */
  getAvailableTools(): ToolDefinition[]

  /**
   * 实际路由并执行模型请求的工具调用。
   * ctx 对应 Go 的 context.Context，用于请求取消。
   */
  execute(ctx: AbortSignal | undefined, call: ToolCall): Promise<ToolResult>
}

/** Registry 接口的默认实现：以工具 Name 为 Key 做 O(1) 路由 */
class RegistryImpl implements Registry {
  private readonly tools = new Map<string, BaseTool>()

  register(tool: BaseTool): void {
    const name = tool.name()
    if (this.tools.has(name)) {
      console.warn(`[Warning] 工具 '${name}' 已经被注册，将被覆盖。`)
    }
    this.tools.set(name, tool)
    console.log(`[Registry] 成功挂载工具: ${name}`)
  }

  getAvailableTools(): ToolDefinition[] {
    return Array.from(this.tools.values()).map((tool) => tool.definition())
  }

  async execute(ctx: AbortSignal | undefined, call: ToolCall): Promise<ToolResult> {
    // 1. 路由查找：找不到说明模型产生了幻觉，直接向模型抛出错误
    const tool = this.tools.get(call.name)
    if (!tool) {
      return {
        toolCallId: call.id,
        output: `Error: 系统中不存在名为 '${call.name}' 的工具。`,
        isError: true,
      }
    }

    // 2. 执行工具逻辑：将原始的 JSON 字节流直接丢给具体工具
    try {
      const output = await tool.execute(ctx, toRawJSON(call.arguments))
      return {
        toolCallId: call.id,
        output,
        isError: false,
      }
    } catch (err) {
      // 3. 封装底层物理错误后返回给 Main Loop
      return {
        toolCallId: call.id,
        output: `Error executing ${call.name}: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      }
    }
  }
}

/** 将 ToolCall.arguments 规范为原始 JSON 字节（对应 Go 的 json.RawMessage） */
function toRawJSON(args: unknown): Uint8Array {
  if (args instanceof Uint8Array) return args
  if (typeof args === "string") return new TextEncoder().encode(args)
  return new TextEncoder().encode(JSON.stringify(args ?? null))
}

/** 创建默认 Registry 实现 */
export function createRegistry(): Registry {
  return new RegistryImpl()
}
