// internal/engine/loop.ts
// 对应 Go: internal/engine/loop.go

import { createPromptComposer } from "../context/composer.ts"
import { log, verbose } from "../log/log.ts"
import type { LLMProvider } from "../provider/provider.ts"
import type { Message } from "../provider/schema.ts"
import type { Registry } from "../tools/registry.ts"
import type { Reporter } from "./reporter.ts"
import type { Session } from "./session.ts"
import { runWithWorkDir } from "./workdir-context.ts"

/** AgentEngine 是微型 OS 的核心驱动 */
export class AgentEngine {
  private provider: LLMProvider
  private registry: Registry

  /** 慢思考模式开关 */
  readonly enableThinking: boolean

  // 【注意】：我们移除了 Engine 层级的 WorkDir，因为 WorkDir 现在应该跟随 Session 走！
  constructor(
    provider: LLMProvider,
    registry: Registry,
    enableThinking: boolean,
  ) {
    this.provider = provider
    this.registry = registry
    this.enableThinking = enableThinking
  }

  /**
   * 【核心改造】: 移除 userPrompt 参数，改为接收一个具体的 Session 实例。
   * reporter 负责把思考 / 工具 / 最终回复推到 CLI、飞书等展现层。
   * 引擎内部 Turn/Phase 轨迹默认不刷屏；设 CLAW_VERBOSE=1 可见。
   */
  async run(
    ctx: AbortSignal | undefined,
    session: Session,
    reporter: Reporter,
  ): Promise<void> {
    // 工具 IO 跟随 Session.WorkDir（Engine 本身无状态、不绑目录）
    return runWithWorkDir(session.workDir, () =>
      this.runInSession(ctx, session, reporter),
    )
  }

  private async runInSession(
    ctx: AbortSignal | undefined,
    session: Session,
    reporter: Reporter,
  ): Promise<void> {
    // 对应 Go: log.Printf("[Engine] 唤醒会话 [%s]，锁定工作区: %s\n", session.ID, session.WorkDir)
    log(`[Engine] 唤醒会话 [${session.id}]，锁定工作区: ${session.workDir}`)
    verbose(`[Engine] 慢思考模式 (Thinking Phase): ${this.enableThinking}`)

    // 根据当前 Session 的工作区，动态组装最新的 System Prompt
    // 对应 Go: composer := ctxpkg.NewPromptComposer(session.WorkDir)
    const composer = createPromptComposer(session.workDir)
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

      // 4. ================= 并发执行底层工具 =================
      //
      // 三个驾驭工程细节（对应 Go 的 Goroutine + WaitGroup 实践）：
      // 1) 并发安全 / 闭包陷阱：用 map(async (toolCall, idx) => ...) 传参，
      //    每次回调自带绑定，等价于 go func(idx, call)，不会抢到最后一个循环变量。
      // 2) 无锁设计：预分配 observationMsgs，每个 Promise 只写自己的 idx 坑位，
      //    无需 Mutex；Node 虽是单线程事件循环，这套结构仍保证清晰与可预测。
      // 3) 上下文顺序对齐：模型返回 [ToolA, ToolB] 时期望 [ResultA, ResultB]；
      //    全部完成后再按索引顺序 append，避免乱序追加造成阅读混乱。
      const observationMsgs: Message[] = new Array(actionResp.toolCalls.length)

      // Promise.all ≈ sync.WaitGroup.Wait()：并发跑完再继续
      await Promise.all(
        actionResp.toolCalls.map(async (toolCall, idx) => {
          const args =
            typeof toolCall.arguments === "string"
              ? toolCall.arguments
              : JSON.stringify(toolCall.arguments ?? {})

          verbose(`  -> [Go-${idx}] 🛠️ 触发并行执行: ${toolCall.name}`)
          await reporter.onToolCall(ctx, toolCall.name, args)

          const result = await this.registry.execute(ctx, toolCall)

          if (result.isError) {
            verbose(`  -> [Go-${idx}] ❌ 工具执行报错: ${result.output}`)
          } else {
            verbose(
              `  -> [Go-${idx}] ✅ 工具执行成功 (返回 ${result.output.length} 字节)`,
            )
          }

          let displayOutput = result.output
          if (displayOutput.length > 200) {
            displayOutput = displayOutput.slice(0, 200) + "... (已截断)"
          }
          await reporter.onToolResult(
            ctx,
            toolCall.name,
            displayOutput,
            result.isError,
          )

          // 专属 idx 坑位写入（无锁、保序）
          observationMsgs[idx] = {
            role: "user",
            content: result.output,
            toolCallId: toolCall.id,
          }
        }),
      )

      verbose(
        "[Engine] 所有并发工具执行完毕，开始聚合观察结果 (Observation)...",
      )

      // 将所有的工具执行结果（Observation）持久化到 Session 中，开启下一轮的复盘与推理
      // 下一轮循环会通过 GetWorkingMemory 从 Session 重新组装上下文，无需再改本轮 contextHistory
      session.append(...observationMsgs)
    }
  }
}
