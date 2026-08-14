// internal/observability/tracker.ts
// 对应 Go: internal/observability/tracker.go
//
// 经典的装饰器模式：实现一个“假”的 LLMProvider，内部包裹着“真”的 Provider。

import type { Session } from "../engine/session.ts"
import { log } from "../log/log.ts"
import type { LLMProvider } from "../provider/interface.ts"
import type { Message, ToolDefinition } from "../schema/message.ts"

/**
 * PricingModel 定义了不同大模型的计费标准 (单位: 美元/1M Tokens)
 * 为了演示，这里硬编码了当前市面上几个主流模型的官方大致定价。
 */
export const PricingModel: Record<
  string,
  { inputPrice: number; outputPrice: number }
> = {
  // 这里假定的大模型价格(每百万Token，tk)
  "glm-4.5-air": { inputPrice: 0.15, outputPrice: 0.15 },
}

/** CostTracker 是一个包装了真实 LLMProvider 的装饰器中间件 */
export class CostTracker implements LLMProvider {
  private readonly nextProvider: LLMProvider
  private readonly modelName: string
  /** 当前所属的会话 (用于累加总成本) */
  private readonly session: Session | null

  constructor(
    next: LLMProvider,
    modelName: string,
    session: Session | null,
  ) {
    this.nextProvider = next
    this.modelName = modelName
    this.session = session
  }

  /**
   * Generate 实现了 LLMProvider 接口！这意味着它可以被无缝注入到 Main Loop 中。
   */
  async generate(
    ctx: AbortSignal | undefined,
    msgs: Message[],
    availableTools: ToolDefinition[] | undefined,
  ): Promise<Message> {
    // 1. 记录请求发起的时刻
    const startTime = Date.now()

    // 2. 调用真实的底层大模型去执行耗时的网络请求
    let respMsg: Message
    try {
      respMsg = await this.nextProvider.generate(ctx, msgs, availableTools)
    } catch (err) {
      // 3. 计算耗时；如果报错了，只打印报错时间，不计费
      const latencyMs = Date.now() - startTime
      log(`[Tracker] ❌ API 调用失败，耗时: ${formatLatency(latencyMs)}`)
      throw err
    }

    // 3. 计算耗时
    const latencyMs = Date.now() - startTime

    // 4. 解析 Token 并计算成本
    if (respMsg.usage) {
      const promptTokens = respMsg.usage.promptTokens
      const completionTokens = respMsg.usage.completionTokens

      let cost = 0
      const price = PricingModel[this.modelName]
      if (price) {
        // 计算花费 = (输入Tokens * 输入单价 + 输出Tokens * 输出单价) / 1000000
        cost =
          (promptTokens * price.inputPrice +
            completionTokens * price.outputPrice) /
          1_000_000
      }

      // 5. 打印精美的仪表盘日志
      log(
        `[Tracker] 📊 API 调用完成 | 耗时: ${formatLatency(latencyMs)} | 输入: ${promptTokens} tk | 输出: ${completionTokens} tk | 花费: ¥${cost.toFixed(6)}`,
      )

      // 6. 将账单累加到当前的 Session 中，供人类后续随时查询
      if (this.session) {
        this.session.recordUsage(promptTokens, completionTokens, cost)
        log(
          `[Tracker] 💰 当前会话 (${this.session.id}) 累计花费: ¥${this.session.totalCostCNY.toFixed(6)}`,
        )
      }
    } else {
      log(
        `[Tracker] ⚠️ API 调用完成，但未返回 Usage 数据 | 耗时: ${formatLatency(latencyMs)}`,
      )
    }

    return respMsg
  }
}

/** 工厂：对应 Go 的 NewCostTracker */
export function createCostTracker(
  next: LLMProvider,
  modelName: string,
  session: Session | null,
): CostTracker {
  return new CostTracker(next, modelName, session)
}

/** 将毫秒耗时格式化为接近 Go time.Duration 的可读字符串 */
function formatLatency(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(3)}s`
}
