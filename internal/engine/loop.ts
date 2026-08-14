// internal/engine/loop.ts
// 对应 Go: internal/engine/loop.go

import { createPromptComposer } from "../context/composer.ts"
import {
  createRecoveryManager,
  type RecoveryManager,
} from "../context/recovery.ts"
import { log, verbose } from "../log/log.ts"
import {
  asTraceContext,
  exportTraceToFile,
  signalOf,
  startSpan,
  type TraceContext,
} from "../observability/trace.ts"
import type { LLMProvider } from "../provider/provider.ts"
import type { Message, ToolCall, ToolResult } from "../provider/schema.ts"
import type { Registry } from "../tools/registry.ts"
import type { AgentRunner } from "../tools/subagent.ts"
import {
  createReminderInjector,
  type ReminderInjector,
} from "./reminder.ts"
import type { Reporter } from "./reporter.ts"
import type { Session } from "./session.ts"

/** AgentEngine 是微型 OS 的核心驱动 */
export class AgentEngine implements AgentRunner {
  private provider: LLMProvider
  private registry: Registry
  /** 【新增】自愈管理器 */
  private recovery: RecoveryManager
  /** 【新增】提醒注入器 */
  private injector: ReminderInjector

  /** 慢思考模式开关 */
  readonly enableThinking: boolean
  /** 【新增】暴露给外部的计划模式开关 */
  readonly planMode: boolean

  // 【注意】：我们移除了 Engine 层级的 WorkDir，因为 WorkDir 现在应该跟随 Session 走！
  constructor(
    provider: LLMProvider,
    registry: Registry,
    enableThinking: boolean,
    planMode = false,
  ) {
    this.provider = provider
    this.registry = registry
    this.enableThinking = enableThinking
    this.planMode = planMode
    // 对应 Go: recovery: ctxpkg.NewRecoveryManager()
    this.recovery = createRecoveryManager()
    // 对应 Go: injector: NewReminderInjector()
    this.injector = createReminderInjector()
  }

  /**
   * 【核心改造】: 移除 userPrompt 参数，改为接收一个具体的 Session 实例。
   * reporter 负责把思考 / 工具 / 最终回复推到 CLI、飞书等展现层。
   * 引擎内部 Turn/Phase 轨迹默认不刷屏；设 CLAW_VERBOSE=1 可见。
   *
   * 讲义同款：工具 Registry 仍在构造时绑定固定 WorkDir；Session.WorkDir 主要用于
   * PromptComposer。双目录文件隔离靠 main 里 mock（Session B 不准调工具）。
   *
   * ctx 可为 AbortSignal（历史调用方）或 TraceContext（带 Span 级联）。
   */
  async run(
    ctx: AbortSignal | TraceContext | undefined,
    session: Session,
    reporter: Reporter,
  ): Promise<void> {
    // 对应 Go: log.Printf("[Engine] 唤醒会话 [%s]，锁定工作区: %s (PlanMode: %v)\n", ...)
    log(
      `[Engine] 唤醒会话 [${session.id}]，锁定工作区: ${session.workDir} (PlanMode: ${this.planMode})`,
    )
    verbose(`[Engine] 慢思考模式 (Thinking Phase): ${this.enableThinking}`)

    // 【埋点 1】：开启 Root Span，记录整个任务的生命周期
    let traceCtx: TraceContext | undefined
    let rootSpan: ReturnType<typeof startSpan>[1]
    ;[traceCtx, rootSpan] = startSpan(asTraceContext(ctx), "Agent.Run")
    rootSpan.addAttribute("SessionID", session.id)
    rootSpan.addAttribute("WorkDir", session.workDir)

    try {
      // 在每次运行前，动态生成组装器并传入当前的 PlanMode 状态
      // 对应 Go: composer := ctxpkg.NewPromptComposer(session.WorkDir, e.PlanMode)
      const composer = createPromptComposer(session.workDir, this.planMode)
      const systemMsg = composer.build()

      let turnCount = 0

      // The Main Loop: 心跳开始 (标准的 ReAct 循环)
      while (true) {
        if (signalOf(traceCtx)?.aborted) break

        turnCount++

        // 【埋点 2】：记录单次 Turn 循环
        // 注意：Go 讲义在 for 里写 defer EndSpan 会拖到函数退出才跑；
        // Node 用每轮 try/finally，保证本轮结束即结算耗时。
        const [turnCtx, turnSpan] = startSpan(
          traceCtx,
          `Turn-${turnCount}`,
        )

        try {
          const availableTools = this.registry.getAvailableTools()

          // 对应 Go: workingMemory := session.GetWorkingMemory(20)
          const workingMemory = session.getWorkingMemory(20)

          const contextHistory: Message[] = [systemMsg, ...workingMemory]
          // 对应 Go: compactedContext := e.compactor.Compact(contextHistory)
          // TS 尚未移植 Compactor，此处透传
          let compactedContext = contextHistory

          // 记录发给模型的实际上下文大小，非常有助于排查幻觉
          turnSpan.addAttribute(
            "context_message_count",
            compactedContext.length,
          )

          let currentTurnThinkingContent = ""

          // ================= Phase 1: Thinking =================
          if (this.enableThinking) {
            verbose(
              "[Engine][Phase 1] 剥夺工具访问权，强制进入慢思考与规划阶段...",
            )
            await reporter.onThinking(signalOf(turnCtx))

            // 【埋点 3】：记录 Thinking 调用
            const [thinkCtx, thinkSpan] = startSpan(turnCtx, "LLM.Thinking")
            log("[Engine] 正在请求 LLM（慢思考，无工具）…")
            let thinkResp: Message
            try {
              thinkResp = await this.provider.generate(
                signalOf(thinkCtx),
                compactedContext,
                undefined,
              )
            } finally {
              thinkSpan.endSpan()
            }
            log("[Engine] LLM 慢思考返回")

            if (thinkResp.content) {
              currentTurnThinkingContent = thinkResp.content
              verbose(`🧠 [内部思考 Trace]: ${thinkResp.content}`)
              // 对应 Go：仅追加到本轮 compactedContext，不单独写入 Session
              compactedContext = [...compactedContext, thinkResp]
            }
          }

          // ================= Phase 2: Action =================
          verbose("[Engine][Phase 2] 恢复工具挂载，等待模型采取行动...")

          // 【埋点 4】：记录 Action 调用
          const [actCtx, actSpan] = startSpan(turnCtx, "LLM.Action")
          log("[Engine] 正在请求 LLM（行动阶段，挂载工具）…")
          let actionResp: Message
          try {
            actionResp = await this.provider.generate(
              signalOf(actCtx),
              compactedContext,
              availableTools,
            )
          } finally {
            actSpan.endSpan()
          }
          log("[Engine] LLM 行动阶段返回")

          // 对应 Go：合并 Thinking + Action 为合法的单条 Assistant 消息
          const finalAssistantMsg: Message = {
            role: "assistant",
            content: [currentTurnThinkingContent, actionResp.content ?? ""]
              .join("\n")
              .trim(),
            toolCalls: actionResp.toolCalls,
          }
          session.append(finalAssistantMsg)

          if (actionResp.content) {
            verbose(`🤖 [对外回复]: ${actionResp.content}`)
            await reporter.onMessage(signalOf(turnCtx), actionResp.content)
          }

          if (!actionResp.toolCalls || actionResp.toolCalls.length === 0) {
            verbose("[Engine] 模型未请求调用工具，任务宣告完成。")
            break
          }

          verbose(
            `[Engine] 模型请求并发调用 ${actionResp.toolCalls.length} 个工具...`,
          )

          const observationMsgs: Message[] = new Array(
            actionResp.toolCalls.length,
          )

          // 用于收集本轮执行的最后一个工具供 Reminder 分析
          let lastToolCall: ToolCall | undefined
          let lastToolResult: ToolResult | undefined

          // 并发执行工具：传 turnCtx，多个 Tool.Execute Span 平行挂在 Turn 下
          await Promise.all(
            actionResp.toolCalls.map(async (toolCall, idx) => {
              const args =
                typeof toolCall.arguments === "string"
                  ? toolCall.arguments
                  : JSON.stringify(toolCall.arguments ?? {})

              await reporter.onToolCall(
                signalOf(turnCtx),
                toolCall.name,
                args,
              )

              const result = await this.registry.execute(turnCtx, toolCall)

              let finalOutput = result.output
              if (result.isError) {
                finalOutput = this.recovery.analyzeAndInject(
                  toolCall.name,
                  result.output,
                )
              }

              let displayOutput = finalOutput
              if (displayOutput.length > 200) {
                displayOutput = displayOutput.slice(0, 200) + "... (已截断)"
              }
              await reporter.onToolResult(
                signalOf(turnCtx),
                toolCall.name,
                displayOutput,
                result.isError,
              )

              observationMsgs[idx] = {
                role: "user",
                content: finalOutput,
                toolCallId: toolCall.id,
              }

              if (idx === 0) {
                lastToolCall = toolCall
                lastToolResult = result
              }
            }),
          )

          session.append(...observationMsgs)

          // 【核心防线】：在进入下一轮前，进行死循环探测与注入
          if (lastToolCall && lastToolResult) {
            const reminderMsg = this.injector.checkAndInject(
              lastToolCall,
              lastToolResult,
            )
            if (reminderMsg) {
              session.append(reminderMsg)
            }
          }
        } finally {
          turnSpan.endSpan()
        }
      }
    } finally {
      // defer：无论成功失败，结束根 Span 并导出 Trace 报告
      rootSpan.endSpan()
      try {
        await exportTraceToFile(rootSpan, session.workDir, session.id)
        log(
          "📊 [Tracing] 本次任务的执行回放链路已保存至工作区的 .claw/traces 目录下",
        )
      } catch (err) {
        log(
          `📊 [Tracing] 导出 Trace 失败: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }
  }

  /**
   * RunSub 是专为 Subagent 拉起的一次性受限循环。
   * 它不依赖外部 Session，打完就跑。
   * Reporter：为了让用户在终端看到子智能体的工作轨迹，我们将主线程的 Reporter 透传进来，并打上特殊标记。
   */
  async runSub(
    ctx: AbortSignal | undefined,
    taskPrompt: string,
    readOnlyRegistry: Registry,
    reporter: unknown,
  ): Promise<string> {
    // 【核心优化】：子智能体极其容易偷懒。我们必须在 System Prompt 中严厉警告它必须使用工具！
    const contextHistory: Message[] = [
      {
        role: "system",
        content: `你是一个专门负责深度探索的探路者 (Explorer Subagent)。
你的任务是根据主架构师的指令，在当前工作区内仔细阅读代码、查阅日志，搜集足够的信息。

【核心纪律】
1. 你必须、且只能依靠内置工具（如 bash 的 find/grep，或 read_file）去寻找答案。绝对不允许凭空捏造或猜测！
2. 如果你没有找到确切的答案，你必须继续使用工具深入搜索。
3. 当且仅当你找到了确切的线索后，停止调用工具，直接输出一段纯文本作为你的终极汇报。主架构师会根据你的汇报来做下一步决策。`,
      },
      {
        role: "user",
        content: taskPrompt,
      },
    ]

    // 限制子智能体最多只能跑 10 个 Turn，防止它自己卡死
    const maxSubTurns = 10
    let turnCount = 0

    const r = isReporter(reporter) ? reporter : null

    while (true) {
      turnCount++
      if (turnCount > maxSubTurns) {
        throw new Error(
          `子智能体探索过于深入，超过 ${maxSubTurns} 轮被强制召回，请主 Agent 给它更明确的指令`,
        )
      }

      if (ctx?.aborted) {
        throw new Error("子智能体推理失败: 任务被取消")
      }

      // 【驾驭底线】：子智能体仅能获取传入的只读工具注册表
      const availableTools = readOnlyRegistry.getAvailableTools()

      // 对应 Go: compactedContext := e.compactor.Compact(contextHistory)
      const compactedContext = contextHistory

      // 子任务要求急速响应，强制关闭主体的慢思考，直接预测行动
      let actionResp: Message
      try {
        actionResp = await this.provider.generate(
          ctx,
          compactedContext,
          availableTools,
        )
      } catch (err) {
        throw new Error(
          `子智能体推理失败: ${err instanceof Error ? err.message : String(err)}`,
        )
      }

      contextHistory.push(actionResp)

      // 【核心退出条件】：子智能体一旦不调用工具了，说明它做好了总结汇报
      if (!actionResp.toolCalls || actionResp.toolCalls.length === 0) {
        return actionResp.content ?? ""
      }

      // 执行只读工具的并发循环
      const observationMsgs: Message[] = new Array(actionResp.toolCalls.length)

      await Promise.all(
        actionResp.toolCalls.map(async (toolCall, idx) => {
          const args =
            typeof toolCall.arguments === "string"
              ? toolCall.arguments
              : JSON.stringify(toolCall.arguments ?? {})

          // 【可视化的关键】：让终端用户看到 Subagent 正在干嘛
          if (r) {
            await r.onToolCall(ctx, `[Subagent] ${toolCall.name}`, args)
          }

          const result = await readOnlyRegistry.execute(ctx, toolCall)

          let finalOutput = result.output
          if (result.isError) {
            finalOutput = this.recovery.analyzeAndInject(
              toolCall.name,
              result.output,
            )
          }

          if (r) {
            let display = finalOutput
            if (display.length > 200) {
              display = display.slice(0, 200) + "... (已截断)"
            }
            await r.onToolResult(
              ctx,
              `[Subagent] ${toolCall.name}`,
              display,
              result.isError,
            )
          }

          observationMsgs[idx] = {
            role: "user",
            content: finalOutput,
            toolCallId: toolCall.id,
          }
        }),
      )

      contextHistory.push(...observationMsgs)
    }
  }
}

/** 粗判 reporter 是否实现了引擎 Reporter 接口（对应 Go 的类型断言） */
function isReporter(value: unknown): value is Reporter {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as Reporter).onMessage === "function" &&
    typeof (value as Reporter).onToolCall === "function"
  )
}
