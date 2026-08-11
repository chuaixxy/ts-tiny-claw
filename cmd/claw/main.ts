/* npx tsx cmd/claw/main.ts  */

import { AgentEngine } from "../../internal/engine/loop.ts"
import type { LLMProvider } from "../../internal/provider/interface.ts"
import type {
  Message,
  ToolCall,
  ToolDefinition,
  ToolResult,
} from "../../internal/schema/message.ts"
import type { Registry } from "../../internal/tools/registry.ts"

// ==========================================
// 1. 升级版 Mock Provider
// ==========================================
class MockProvider implements LLMProvider {
  private turn = 0

  async generate(
    _ctx: AbortSignal | undefined,
    _messages: Message[],
    availableTools: ToolDefinition[] | undefined,
  ): Promise<Message> {
    // 如果工具列表为空，说明这是引擎发起的 Phase 1: Thinking 阶段
    if (!availableTools || availableTools.length === 0) {
      return {
        role: "assistant",
        content:
          "【推理中】目标是检查文件。我不能直接盲猜，我需要先调用 bash 工具执行 ls 命令，看看当前目录下有什么，然后再做定夺。",
      }
    }

    // 如果工具列表不为空，说明这是 Phase 2: Action 阶段
    this.turn++
    if (this.turn === 1) {
      // 第一轮 Action：顺着刚才的 Thinking，精准调用工具
      return {
        role: "assistant",
        content: "我要执行我刚才计划的步骤了。",
        toolCalls: [
          {
            id: "call_123",
            name: "bash",
            arguments: { command: "ls -la" },
          },
        ],
      }
    }

    // 第二轮 Action：直接总结退出
    return {
      role: "assistant",
      content: "根据工具返回的结果，我看到了 main.ts，任务圆满完成！",
    }
  }
}

// ==========================================
// 2. 伪造的 Tool Registry
// ==========================================
class MockRegistry implements Registry {
  getAvailableTools(): ToolDefinition[] {
    // 为了让 Phase 2 能检测到工具，这里返回一个伪造的工具定义数组
    return [
      {
        name: "bash",
        description: "Execute a shell command",
        inputSchema: {
          type: "object",
          properties: {
            command: { type: "string" },
          },
        },
      },
    ]
  }

  async execute(_ctx: AbortSignal | undefined, call: ToolCall): Promise<ToolResult> {
    return {
      toolCallId: call.id,
      output: "-rw-r--r--  1 user group  234 Oct 24 10:00 main.ts\n",
      isError: false,
    }
  }
}

// ==========================================
// 3. 组装运行
// ==========================================
async function main() {
  // 获取当前执行目录作为 WorkDir 物理边界
  const workDir = process.cwd()

  const provider = new MockProvider()
  const registry = new MockRegistry()

  // 实例化引擎，开启 enableThinking = true
  const eng = new AgentEngine(provider, registry, workDir, true)

  // 发起任务指令
  try {
    await eng.run(undefined, "帮我检查当前目录的文件")
  } catch (err) {
    console.error("引擎崩溃:", err)
    process.exit(1)
  }
}

await main()
