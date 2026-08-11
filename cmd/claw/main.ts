/* npx tsx cmd/claw/main.ts  */

import { AgentEngine } from "../../internal/engine/loop.ts"
import { createZhipuOpenAIProvider } from "../../internal/provider/openai.ts"
// 也可换成 Claude 兼容端点：createZhipuClaudeProvider from "../../internal/provider/claude.ts"
import type {
  ToolCall,
  ToolDefinition,
  ToolResult,
} from "../../internal/schema/message.ts"
import type { Registry } from "../../internal/tools/registry.ts"

// ==========================================
// 1. 伪造的 Tool Registry（真实 Registry 稍后接入）
// ==========================================
class MockRegistry implements Registry {
  getAvailableTools(): ToolDefinition[] {
    return [
      {
        name: "get_weather",
        description: "获取指定城市的当前天气情况。",
        inputSchema: {
          type: "object",
          properties: {
            city: {
              type: "string",
            },
          },
          required: ["city"],
        },
      },
    ]
  }

  async execute(_ctx: AbortSignal | undefined, call: ToolCall): Promise<ToolResult> {
    console.log(`  -> [Mock 工具执行] 获取 ${call.name} 的天气中...`)
    return {
      toolCallId: call.id,
      output: "API 返回：今天是晴天，气温 25 度。",
      isError: false,
    }
  }
}

// ==========================================
// 2. 组装运行（Thinking ON / OFF 各跑一遍）
// ==========================================
async function runOnce(enableThinking: boolean): Promise<void> {
  const label = enableThinking ? "ON" : "OFF"
  console.log("\n" + "=".repeat(60))
  console.log(`[main] ========== enableThinking: ${label} ==========`)
  console.log("=".repeat(60) + "\n")

  const workDir = process.cwd()
  const llmProvider = createZhipuOpenAIProvider("glm-4.5-air")
  const registry = new MockRegistry()
  const eng = new AgentEngine(llmProvider, registry, workDir, enableThinking)

  const prompt = "我想去北京跑步，帮我查查天气适合吗？"
  await eng.run(undefined, prompt)
}

async function main() {
  if (!process.env.ZHIPU_API_KEY) {
    console.error("请先导出 ZHIPU_API_KEY 环境变量")
    process.exit(1)
  }

  try {
    await runOnce(true)
    await runOnce(false)
  } catch (err) {
    console.error("引擎崩溃:", err)
    process.exit(1)
  }
}

await main()
