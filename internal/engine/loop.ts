// internal/engine/loop.ts
// 对应 Go: internal/engine/loop.go

import {
  createPromptComposer,
  type PromptComposer,
} from "../context/composer.ts"
import { log, verbose } from "../log/log.ts"
import type { LLMProvider } from "../provider/provider.ts"
import type { Message } from "../provider/schema.ts"
import type { Registry } from "../tools/registry.ts"
import type { Reporter } from "./reporter.ts"

/** AgentEngine 是微型 OS 的核心驱动 */
export class AgentEngine {
  private provider: LLMProvider
  private registry: Registry

  /** WorkDir (工作区): 借鉴 OpenClaw 的理念，Agent 必须有一个明确的物理边界 */
  readonly workDir: string
  /** 慢思考模式开关 */
  readonly enableThinking: boolean

  /** 【新增】引擎持有 Composer 实例 —— 动态组装 System Prompt */
  private readonly composer: PromptComposer

  constructor(
    provider: LLMProvider,
    registry: Registry,
    workDir: string,
    enableThinking: boolean,
  ) {
    this.provider = provider
    this.registry = registry
    this.workDir = workDir
    this.enableThinking = enableThinking
    // 对应 Go: composer: ctxpkg.NewPromptComposer(workDir)
    this.composer = createPromptComposer(workDir)
  }

  /**
   * 启动 Agent 的生命周期。
   * reporter 负责把思考 / 工具 / 最终回复推到 CLI、飞书等展现层。
   * 引擎内部 Turn/Phase 轨迹默认不刷屏；设 CLAW_VERBOSE=1 可见。
   */
  async run(
    ctx: AbortSignal | undefined,
    userPrompt: string,
    reporter: Reporter,
  ): Promise<void> {
    // 对应 Go: log.Printf("[Engine] 引擎启动，锁定工作区: %s\n", e.WorkDir)
    log(`[Engine] 引擎启动，锁定工作区: ${this.workDir}`)
    verbose(`[Engine] 慢思考模式 (Thinking Phase): ${this.enableThinking}`)

    // 【核心修改】动态组装 System Prompt，彻底替换掉以前硬编码的面条提示词！
    // 对应 Go: systemMsg := e.composer.Build()
    const systemMsg = this.composer.build()

    // 注入动态组装的内核、AGENTS.md 与 Skills
    const contextHistory: Message[] = [
      systemMsg,
      {
        role: "user",
        content: userPrompt,
      },
    ]

    let turnCount = 0

    // 2. The Main Loop: 心跳开始 (标准的 ReAct 循环)
    // Main Loop 后续的 for 循环、Phase 1/2 思考与并发执行，与第 09 讲保持一致
    while (true) {
      if (ctx?.aborted) break

      turnCount++
      verbose(`\n========== [Turn ${turnCount}] 开始 ==========`)

      // 获取当前挂载的所有工具定义
      const availableTools = this.registry.getAvailableTools()

      // ====================================================================
      // Phase 1: 慢思考阶段 (Thinking) - 剥夺工具，强制规划
      // ====================================================================
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

        // 如果模型输出了思考过程，我们将其作为 Assistant 消息追加到上下文中
        if (thinkResp.content) {
          verbose(`🧠 [内部思考 Trace]: ${thinkResp.content}`)
          contextHistory.push(thinkResp)
        }
      }

      // ====================================================================
      // Phase 2: 行动阶段 (Action) - 恢复工具，顺着规划执行
      // ====================================================================
      verbose("[Engine][Phase 2] 恢复工具挂载，等待模型采取行动...")

      // 此时的 contextHistory 中已经包含了上一阶段模型自己的 Thinking Trace。
      // 模型会顺着自己的逻辑，结合恢复的 availableTools 发起精准的工具调用。
      log("[Engine] 正在请求 LLM（行动阶段，挂载工具）…")
      const actionResp = await this.provider.generate(
        ctx,
        contextHistory,
        availableTools,
      )
      log("[Engine] LLM 行动阶段返回")

      contextHistory.push(actionResp)

      if (actionResp.content) {
        // 中间回合的助手碎碎念只进 verbose；最终纯文本由 reporter.onMessage 展示
        verbose(`🤖 [对外回复]: ${actionResp.content}`)
      }

      // ====================================================================
      // 退出与执行逻辑
      // ====================================================================
      if (!actionResp.toolCalls || actionResp.toolCalls.length === 0) {
        verbose("[Engine] 模型未请求调用工具，任务宣告完成。")
        if (actionResp.content) {
          await reporter.onMessage(ctx, actionResp.content)
        }
        break
      }

      verbose(
        `[Engine] 模型请求并发调用 ${actionResp.toolCalls.length} 个工具...`,
      )

      // 【核心改造】: 从串行 (Sequential) 演进为并行 (Parallel)
      //
      // 三个驾驭工程细节（对应 Go 的 Goroutine + WaitGroup 实践）：
      // 1) 并发安全 / 闭包陷阱：用 map(async (toolCall, idx) => ...) 传参，
      //    每次回调自带绑定，等价于 go func(idx, call)，不会抢到最后一个循环变量。
      // 2) 无锁设计：预分配 observationMsgs，每个 Promise 只写自己的 idx 坑位，
      //    无需 Mutex；Node 虽是单线程事件循环，这套结构仍保证清晰与可预测。
      // 3) 上下文顺序对齐：模型返回 [ToolA, ToolB] 时期望 [ResultA, ResultB]；
      //    全部完成后再按索引顺序 push，避免乱序追加造成阅读混乱。
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

          await reporter.onToolResult(
            ctx,
            toolCall.name,
            result.output,
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

      // 按原始 ToolCall 顺序一次性追加到上下文时间线
      contextHistory.push(...observationMsgs)

      // 循环回到开头，模型将带着这一批新的 Observation 继续它的下一轮思考...
    }
  }
}
