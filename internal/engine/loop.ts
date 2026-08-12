import { log } from "../log/log.ts"
import type { LLMProvider } from "../provider/provider.ts"
import type { Message } from "../provider/schema.ts"
import type { Registry } from "../tools/registry.ts"

/** AgentEngine 是微型 OS 的核心驱动 */
export class AgentEngine {
  private provider: LLMProvider
  private registry: Registry

  /** WorkDir (工作区): 借鉴 OpenClaw 的理念，Agent 必须有一个明确的物理边界 */
  readonly workDir: string
  /** 慢思考模式开关 */
  readonly enableThinking: boolean

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
  }

  /** 启动 Agent 的生命周期 */
  async run(ctx: AbortSignal | undefined, userPrompt: string): Promise<void> {
    log(`[Engine] 引擎启动，锁定工作区: ${this.workDir}`)
    log(`[Engine] 慢思考模式 (Thinking Phase): ${this.enableThinking}`)

    // 1. 初始化会话的 Context (上下文内存)
    // 在真实的场景中，这里会由动态 Prompt 组装器加载 AGENTS.md。目前我们先硬编码。
    const contextHistory: Message[] = [
      {
        role: "system",
        content: "You are go-tiny-claw, an expert coding assistant. You have full access to tools in the workspace.",
      },
      {
        role: "user",
        content: userPrompt,
      },
    ]

    let turnCount = 0

    // 2. The Main Loop: 心跳开始 (标准的 ReAct 循环)
    while (true) {
      if (ctx?.aborted) break

      turnCount++
      log(`\n========== [Turn ${turnCount}] 开始 ==========`)

      // 获取当前挂载的所有工具定义
      const availableTools = this.registry.getAvailableTools()

      // ====================================================================
      // Phase 1: 慢思考阶段 (Thinking) - 剥夺工具，强制规划
      // ====================================================================
      if (this.enableThinking) {
        log("[Engine][Phase 1] 剥夺工具访问权，强制进入慢思考与规划阶段...")

        // 核心机制：传入的 availableTools 为 undefined / 空！
        // 大模型看不到任何 JSON Schema，被迫只能输出纯文本的思考过程。
        const thinkResp = await this.provider.generate(ctx, contextHistory, undefined)

        // 如果模型输出了思考过程，我们将其作为 Assistant 消息追加到上下文中
        if (thinkResp.content) {
          log(`🧠 [内部思考 Trace]: ${thinkResp.content}`)
          contextHistory.push(thinkResp)
        }
      }

      // ====================================================================
      // Phase 2: 行动阶段 (Action) - 恢复工具，顺着规划执行
      // ====================================================================
      log("[Engine][Phase 2] 恢复工具挂载，等待模型采取行动...")

      // 此时的 contextHistory 中已经包含了上一阶段模型自己的 Thinking Trace。
      // 模型会顺着自己的逻辑，结合恢复的 availableTools 发起精准的工具调用。
      const actionResp = await this.provider.generate(ctx, contextHistory, availableTools)

      contextHistory.push(actionResp)

      if (actionResp.content) {
        log(`🤖 [对外回复]: ${actionResp.content}`)
      }

      // ====================================================================
      // 退出与执行逻辑
      // ====================================================================
      if (!actionResp.toolCalls || actionResp.toolCalls.length === 0) {
        log("[Engine] 模型未请求调用工具，任务宣告完成。")
        break
      }

      log(`[Engine] 模型请求调用 ${actionResp.toolCalls.length} 个工具...`)

      for (const toolCall of actionResp.toolCalls) {
        log(`  -> 🛠️ 执行工具: ${toolCall.name}, 参数: ${JSON.stringify(toolCall.arguments)}`)

        // 通过 Registry 路由并执行底层工具
        const result = await this.registry.execute(ctx, toolCall)

        if (result.isError) {
          log(`  -> ❌ 工具执行报错: ${result.output}`)
        } else {
          log(`  -> ✅ 工具执行成功 (返回 ${result.output.length} 字节)`)
        }

        // 将工具执行的观察结果追加到 Context，准备进入下一轮
        // 注意：toolCallId 必须携带！这是维系大模型推理链条的关键
        const observationMsg: Message = {
          role: "user",
          content: result.output,
          toolCallId: toolCall.id,
        }
        contextHistory.push(observationMsg)
      }

      // 循环回到开头，模型将带着新加入的 Observation 继续它的下一轮思考...
    }
  }
}
