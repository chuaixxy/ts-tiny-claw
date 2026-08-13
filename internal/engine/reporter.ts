/**
 * Reporter 定义了 Agent 引擎向外界输出信息的规范。
 * 这使得引擎可以无缝切换终端 (CLI)、飞书、钉钉甚至 WebUI 等不同的展现层。
 *
 * Go 的 context.Context 在此对应 AbortSignal（与 LLMProvider 一致）。
 */
export interface Reporter {
  /** 当模型开始进行慢思考 (Reasoning) 时调用 */
  onThinking(ctx: AbortSignal | undefined): void | Promise<void>

  /** 当模型决定并发调用工具时调用 */
  onToolCall(
    ctx: AbortSignal | undefined,
    toolName: string,
    args: string,
  ): void | Promise<void>

  /** 当工具在底层执行完毕并返回结果时调用 */
  onToolResult(
    ctx: AbortSignal | undefined,
    toolName: string,
    result: string,
    isError: boolean,
  ): void | Promise<void>

  /** 当模型宣告任务完成，向用户输出最终纯文本回答时调用 */
  onMessage(ctx: AbortSignal | undefined, content: string): void | Promise<void>
}

/**
 * MultiReporter：把同一事件扇出到多个 Reporter。
 * 典型用法：飞书长连接时同时挂 TerminalReporter，本地终端也能看到
 * `🤖 Agent 回复` / `[🛠️ 调用工具]` 等与 session 演示一致的日志。
 */
export function createMultiReporter(...reporters: Reporter[]): Reporter {
  return {
    async onThinking(ctx) {
      await Promise.all(reporters.map((r) => r.onThinking(ctx)))
    },
    async onToolCall(ctx, toolName, args) {
      await Promise.all(reporters.map((r) => r.onToolCall(ctx, toolName, args)))
    },
    async onToolResult(ctx, toolName, result, isError) {
      await Promise.all(
        reporters.map((r) => r.onToolResult(ctx, toolName, result, isError)),
      )
    },
    async onMessage(ctx, content) {
      await Promise.all(reporters.map((r) => r.onMessage(ctx, content)))
    },
  }
}
