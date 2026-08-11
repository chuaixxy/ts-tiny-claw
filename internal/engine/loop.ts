import type { LLMProvider } from "../provider/provider.ts"
import type { Message } from "../provider/schema.ts"
import type { Registry } from "../tools/registry.ts"

/** AgentEngine 是微型 OS 的核心驱动 */
export class AgentEngine {
  private provider: LLMProvider
  private registry: Registry

  /** WorkDir (工作区): 借鉴 OpenClaw 的理念，Agent 必须有一个明确的物理边界 */
  readonly workDir: string

  constructor(provider: LLMProvider, registry: Registry, workDir: string) {
    this.provider = provider
    this.registry = registry
    this.workDir = workDir
  }

  /** 启动 Agent 的生命周期 */
  async run(ctx: AbortSignal | undefined, userPrompt: string): Promise<void> {
    console.log(`[Engine] 引擎启动，锁定工作区: ${this.workDir}`)

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
      console.log(`========== [Turn ${turnCount}] 开始 ==========`)

      // 获取当前挂载的所有工具定义
      const availableTools = this.registry.getAvailableTools()

      // 向大模型发起推理请求 (包含 Reasoning)
      console.log("[Engine] 正在思考 (Reasoning)...")
      const responseMsg = await this.provider.generate(ctx, contextHistory, availableTools)

      // 将模型的响应完整追加到上下文历史中
      contextHistory.push(responseMsg)

      // 如果模型回复了纯文本，打印出来 (这通常是它的思考过程，或是最终结果)
      if (responseMsg.content) {
        console.log(`🤖 模型: ${responseMsg.content}`)
      }

      // 3. 退出条件判断
      // 如果模型没有请求任何工具调用，说明它认为任务已经完成，跳出循环。
      if (!responseMsg.toolCalls || responseMsg.toolCalls.length === 0) {
        console.log("[Engine] 任务完成，退出循环。")
        break
      }

      // 4. 执行行动 (Action) 与 获取观察结果 (Observation)
      console.log(`[Engine] 模型请求调用 ${responseMsg.toolCalls.length} 个工具...`)

      for (const toolCall of responseMsg.toolCalls) {
        console.log(`  -> 🛠️ 执行工具: ${toolCall.name}, 参数: ${JSON.stringify(toolCall.arguments)}`)

        // 通过 Registry 路由并执行底层工具
        const result = await this.registry.execute(ctx, toolCall)

        if (result.isError) {
          console.log(`  -> ❌ 工具执行报错: ${result.output}`)
        } else {
          console.log(`  -> ✅ 工具执行成功 (返回 ${result.output.length} 字节)`)
        }

        // 将工具执行的观察结果 (Observation) 封装为 User Message 追加到上下文中
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
