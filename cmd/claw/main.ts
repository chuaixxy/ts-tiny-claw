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
// 1. 伪造的大模型 Provider
// ==========================================
class MockProvider implements LLMProvider {
  private turn = 0

  /** 模拟大模型的响应：第一轮请求执行 bash，第二轮输出最终结果 */
  async generate(
    _messages: Message[],
    _availableTools: ToolDefinition[],
    _signal?: AbortSignal,
  ): Promise<Message> {
    this.turn++
    if (this.turn === 1) {
      return {
        role: "assistant",
        content: "让我来看看当前目录下有什么文件。",
        toolCalls: [
          {
            id: "call_123",
            name: "bash",
            arguments: { command: "ls -la" },
          },
        ],
      }
    }

    return {
      role: "assistant",
      content: "我看到了文件列表，里面包含 main.go，任务完成！",
    }
  }
}

// ==========================================
// 2. 伪造的 Tool Registry
// ==========================================
class MockRegistry implements Registry {
  getAvailableTools(): ToolDefinition[] {
    return []
  }

  async execute(call: ToolCall, _signal?: AbortSignal): Promise<ToolResult> {
    // 直接返回一段伪造的终端输出
    return {
      toolCallId: call.id,
      output: "-rw-r--r--  1 user group  234 Oct 24 10:00 main.go\n",
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

  // 实例化核心引擎
  const eng = new AgentEngine(provider, registry, workDir)

  // 发起任务指令
  try {
    await eng.run("帮我检查当前目录的文件")
  } catch (err) {
    console.error("引擎崩溃:", err)
    process.exit(1)
  }
}

await main()
