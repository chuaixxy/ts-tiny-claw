// internal/tools/registry.ts
// 对应 Go: internal/tools/registry.go

import { log, warn } from "../log/log.ts"
import {
  asTraceContext,
  signalOf,
  startSpan,
  type TraceContext,
} from "../observability/trace.ts"
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

/**
 * MiddlewareFunc 定义了中间件的签名。
 * 它接收当前的 ToolCall，并返回是否允许执行 (allowed)，以及拦截时的原因 (rejectReason)。
 * Node 侧允许返回 Promise，以便 WaitForApproval 异步挂起（对应 Go 里 channel 阻塞）。
 *
 * ctx 保留完整 TraceContext，供审批 Middleware 从中提取专属 Reporter
 * （对应 Go: feishu.ReporterFromContext(ctx)）。
 */
export type MiddlewareFunc = (
  ctx: AbortSignal | TraceContext | undefined,
  call: ToolCall,
) =>
  | { allowed: boolean; rejectReason: string }
  | Promise<{ allowed: boolean; rejectReason: string }>

/** Registry 定义了工具的注册与分发接口 */
export interface Registry {
  /** 挂载一个新的工具到系统中 */
  register(tool: BaseTool): void

  /** 【新增】全局 Middleware 挂载点 */
  use(mw: MiddlewareFunc): void

  /** 返回当前系统挂载的所有工具的 Schema，供 Main Loop 交给 Provider */
  getAvailableTools(): ToolDefinition[]

  /**
   * 实际路由并执行模型请求的工具调用。
   * ctx 可为 AbortSignal（历史调用方）或 TraceContext（挂到父 Span 下）。
   */
  execute(
    ctx: AbortSignal | TraceContext | undefined,
    call: ToolCall,
  ): Promise<ToolResult>
}

/** Registry 接口的默认实现：以工具 Name 为 Key 做 O(1) 路由 */
class RegistryImpl implements Registry {
  private readonly tools = new Map<string, BaseTool>()
  /** 【新增】保存挂载的中间件链 */
  private readonly middlewares: MiddlewareFunc[] = []

  register(tool: BaseTool): void {
    const name = tool.name()
    if (this.tools.has(name)) {
      warn(`[Warning] 工具 '${name}' 已经被注册，将被覆盖。`)
    }
    this.tools.set(name, tool)
    log(`[Registry] 成功挂载工具: ${name}`)
  }

  use(mw: MiddlewareFunc): void {
    this.middlewares.push(mw)
  }

  getAvailableTools(): ToolDefinition[] {
    return Array.from(this.tools.values()).map((tool) => tool.definition())
  }

  async execute(
    ctx: AbortSignal | TraceContext | undefined,
    call: ToolCall,
  ): Promise<ToolResult> {
    // 【埋点 5】：开启工具执行的 Span（并发工具会平行挂在 Turn 节点下）
    const [toolCtx, span] = startSpan(asTraceContext(ctx), "Tool.Execute")
    span.addAttribute("tool_name", call.name)
    // 将 JSON 参数存入以备调试
    span.addAttribute("arguments", argsToString(call.arguments))

    try {
      // 1. 路由查找：找不到说明模型产生了幻觉，直接向模型抛出错误
      const tool = this.tools.get(call.name)
      if (!tool) {
        const msg = `Error: 系统中不存在名为 '${call.name}' 的工具。`
        span.addAttribute("error", msg)
        return {
          toolCallId: call.id,
          output: msg,
          isError: true,
        }
      }

      // 2. 【核心防御】在执行底层逻辑前，依次运行所有的 Middleware
      // 传入完整 toolCtx，而不是剥成 AbortSignal，否则 Reporter 跨界丢失
      const signal = signalOf(toolCtx)
      for (const mw of this.middlewares) {
        const { allowed, rejectReason } = await mw(toolCtx, call)
        if (!allowed) {
          span.addAttribute("intercepted", true)
          span.addAttribute("reject_reason", rejectReason)
          log(
            `[Registry] ⚠️ 工具 ${call.name} 被 Middleware 拦截: ${rejectReason}`,
          )
          return {
            toolCallId: call.id,
            output: `执行被系统拦截。原因: ${rejectReason}`,
            isError: true, // 必须返回 Error，强制大模型阅读拒绝理由
          }
        }
      }

      // 3. 执行工具逻辑 (如果所有 Middleware 都放行了)
      try {
        const output = await tool.execute(signal, toRawJSON(call.arguments))
        // 只截取输出的前 100 字符放入 Trace，防止 Trace 文件过度膨胀
        span.addAttribute("output_preview", truncate(output, 100))
        return {
          toolCallId: call.id,
          output,
          isError: false,
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)
        span.addAttribute("error", errMsg)
        return {
          toolCallId: call.id,
          output: `Error executing ${call.name}: ${errMsg}`,
          isError: true,
        }
      }
    } finally {
      // 无论成功失败，确保结束
      span.endSpan()
    }
  }
}

/** 将 ToolCall.arguments 规范为原始 JSON 字节（对应 Go 的 json.RawMessage） */
function toRawJSON(args: unknown): Uint8Array {
  if (args instanceof Uint8Array) return args
  if (typeof args === "string") return new TextEncoder().encode(args)
  return new TextEncoder().encode(JSON.stringify(args ?? null))
}

function argsToString(args: unknown): string {
  if (typeof args === "string") return args
  if (args instanceof Uint8Array) return new TextDecoder().decode(args)
  return JSON.stringify(args ?? null)
}

/** 对应 Go: truncate —— 截断过长字符串，避免 Trace 膨胀 */
function truncate(s: string, max: number): string {
  if (s.length > max) {
    return s.slice(0, max) + "..."
  }
  return s
}

/** 创建默认 Registry 实现 */
export function createRegistry(): Registry {
  return new RegistryImpl()
}
