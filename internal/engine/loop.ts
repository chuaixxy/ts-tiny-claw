// internal/engine/loop.ts
// 对应 Go: internal/engine/loop.go

import { createPromptComposer } from "../context/composer.ts"
import {
  createRecoveryManager,
  type RecoveryManager,
} from "../context/recovery.ts"
import { log, verbose } from "../log/log.ts"
import type { LLMProvider } from "../provider/provider.ts"
import type { Message, ToolCall, ToolResult } from "../provider/schema.ts"
import type { Registry } from "../tools/registry.ts"
import {
  createReminderInjector,
  type ReminderInjector,
} from "./reminder.ts"
import type { Reporter } from "./reporter.ts"
import type { Session } from "./session.ts"

/** AgentEngine 是微型 OS 的核心驱动 */
export class AgentEngine {
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
   */
  async run(
    ctx: AbortSignal | undefined,
    session: Session,
    reporter: Reporter,
  ): Promise<void> {
    // 对应 Go: log.Printf("[Engine] 唤醒会话 [%s]，锁定工作区: %s (PlanMode: %v)\n", ...)
    log(
      `[Engine] 唤醒会话 [${session.id}]，锁定工作区: ${session.workDir} (PlanMode: ${this.planMode})`,
    )
    verbose(`[Engine] 慢思考模式 (Thinking Phase): ${this.enableThinking}`)

    // 在每次运行前，动态生成组装器并传入当前的 PlanMode 状态
    // 对应 Go: composer := ctxpkg.NewPromptComposer(session.WorkDir, e.PlanMode)
    const composer = createPromptComposer(session.workDir, this.planMode)
    const systemMsg = composer.build()

    let turnCount = 0

    // The Main Loop: 心跳开始 (标准的 ReAct 循环)
    while (true) {
      if (ctx?.aborted) break

      turnCount++
      verbose(`\n========== [Turn ${turnCount}] 开始 ==========`)

      const availableTools = this.registry.getAvailableTools()

      // 1. 【上下文组装】: System Prompt + 截取最近的 6 条消息作为 Working Memory
      // 在实际业务中，由于工具返回结果可能很长，短期工作记忆往往设为 6-10 条足以维系连贯对话
      const workingMemory = session.getWorkingMemory(6)

      const contextHistory: Message[] = [systemMsg, ...workingMemory]

      // 2. ================= Phase 1: Thinking =================
      if (this.enableThinking) {
        verbose("[Engine][Phase 1] 剥夺工具访问权，强制进入慢思考与规划阶段...")
        await reporter.onThinking(ctx)

        // 核心机制：传入的 availableTools 为 undefined / 空！
        // 大模型看不到任何 JSON Schema，被迫只能输出纯文本的思考过程。
        log("[Engine] 正在请求 LLM（慢思考，无工具）…")
        const thinkResp = await this.provider.generate(
          ctx,
          contextHistory,
          undefined,
        )
        log("[Engine] LLM 慢思考返回")

        if (thinkResp.content) {
          verbose(`🧠 [内部思考 Trace]: ${thinkResp.content}`)
          // 将思考过程持久化到 Session 中！
          session.append(thinkResp)
          // 把它追加到当前这一轮的临时上下文中，供 Action 阶段使用
          contextHistory.push(thinkResp)
        }
      }

      // 3. ================= Phase 2: Action =================
      verbose("[Engine][Phase 2] 恢复工具挂载，等待模型采取行动...")

      log("[Engine] 正在请求 LLM（行动阶段，挂载工具）…")
      const actionResp = await this.provider.generate(
        ctx,
        contextHistory,
        availableTools,
      )
      log("[Engine] LLM 行动阶段返回")

      // 将大模型的行动响应持久化到 Session 中
      session.append(actionResp)
      contextHistory.push(actionResp)

      if (actionResp.content) {
        verbose(`🤖 [对外回复]: ${actionResp.content}`)
        await reporter.onMessage(ctx, actionResp.content)
      }

      if (!actionResp.toolCalls || actionResp.toolCalls.length === 0) {
        // 如果没有工具调用，说明本次任务已完成，打破 ReAct 循环，挂起等待人类的下一条指令
        verbose("[Engine] 模型未请求调用工具，任务宣告完成。")
        break
      }

      verbose(
        `[Engine] 模型请求并发调用 ${actionResp.toolCalls.length} 个工具...`,
      )

      // 4. ================= 执行工具并记录 =================
      //
      // 三个驾驭工程细节（对应 Go 的 Goroutine + WaitGroup 实践）：
      // 1) 并发安全 / 闭包陷阱：用 map(async (toolCall, idx) => ...) 传参，
      //    每次回调自带绑定，等价于 go func(idx, call)，不会抢到最后一个循环变量。
      // 2) 无锁设计：预分配 observationMsgs，每个 Promise 只写自己的 idx 坑位，
      //    无需 Mutex；Node 虽是单线程事件循环，这套结构仍保证清晰与可预测。
      // 3) 上下文顺序对齐：模型返回 [ToolA, ToolB] 时期望 [ResultA, ResultB]；
      //    全部完成后再按索引顺序 append，避免乱序追加造成阅读混乱。
      const observationMsgs: Message[] = new Array(actionResp.toolCalls.length)

      // 用于收集本轮执行的最后一个工具，供 Reminder 探测器分析
      // (在真实的工业级架构中，如果并发调用了多个工具，我们可以逐个分析或仅分析报错的那个。这里简化为取第一个)
      let lastToolCall: ToolCall | undefined
      let lastToolResult: ToolResult | undefined

      // Promise.all ≈ sync.WaitGroup.Wait()：并发跑完再继续
      await Promise.all(
        actionResp.toolCalls.map(async (toolCall, idx) => {
          const args =
            typeof toolCall.arguments === "string"
              ? toolCall.arguments
              : JSON.stringify(toolCall.arguments ?? {})

          verbose(`  -> [Go-${idx}] 🛠️ 触发并行执行: ${toolCall.name}`)
          await reporter.onToolCall(ctx, toolCall.name, args)

          // 底层物理执行工具
          const result = await this.registry.execute(ctx, toolCall)

          // 【核心拦截与注入】
          let finalOutput = result.output
          if (result.isError) {
            // 发生错误，交由 RecoveryManager 诊断并注入“锦囊妙计”
            finalOutput = this.recovery.analyzeAndInject(
              toolCall.name,
              result.output,
            )
            log(`  -> [Go-${idx}] ❌ 注入救援指南: ${finalOutput}`)
          } else {
            verbose(
              `  -> [Go-${idx}] ✅ 工具执行成功 (返回 ${result.output.length} 字节)`,
            )
          }

          let displayOutput = finalOutput
          if (displayOutput.length > 200) {
            displayOutput = displayOutput.slice(0, 200) + "... (已截断)"
          }
          await reporter.onToolResult(
            ctx,
            toolCall.name,
            displayOutput,
            result.isError,
          )

          // 将注入过 Recovery Hint 的最终结果写入上下文历史（专属 idx 坑位，无锁、保序）
          observationMsgs[idx] = {
            role: "user",
            content: finalOutput,
            toolCallId: toolCall.id,
          }

          // 捕获状态供外部探测器使用
          if (idx === 0) {
            lastToolCall = toolCall
            lastToolResult = result
          }
        }),
      )

      verbose(
        "[Engine] 所有并发工具执行完毕，开始聚合观察结果 (Observation)...",
      )

      // 1. 先将普通的工具执行结果存入 Session
      session.append(...observationMsgs)

      // 2. 【核心防线】：在准备进入下一轮之前，进行死循环探测！
      if (lastToolCall && lastToolResult) {
        const reminderMsg = this.injector.checkAndInject(
          lastToolCall,
          lastToolResult,
        )
        if (reminderMsg) {
          // 如果触发了干预规则，将这条严厉的提醒作为 User 消息，强制追加到 Session 的最末尾！
          // 大模型在下一轮被唤醒时，第一眼就会看到这句话，从而打破局部执念。
          session.append(reminderMsg)
        }
      }
    }
  }
}
