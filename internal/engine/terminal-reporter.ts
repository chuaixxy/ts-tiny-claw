// internal/engine/terminal-reporter.ts
// 对应 Go: internal/engine/terminal_reporter.go
//
// 专门用于终端打印的 Reporter 实现，便于在本地命令行测试动态 Prompt 的威力。

import type { Reporter } from "./reporter.ts"

/** TerminalReporter 实现了 Reporter 接口，用于在终端直观地打印 Agent 的状态 */
export class TerminalReporter implements Reporter {
  async onThinking(_ctx: AbortSignal | undefined): Promise<void> {
    // 对应 Go: fmt.Printf("\n[🤔 思考中] 模型正在推理...\n")
    console.log("\n[🤔 思考中] 模型正在推理...")
  }

  async onToolCall(
    _ctx: AbortSignal | undefined,
    toolName: string,
    args: string,
  ): Promise<void> {
    console.log(`[🛠️ 调用工具] ${toolName}`)

    // 截断过长的参数显示，保持终端清爽
    let displayArgs = args.replaceAll("\n", "\\n").replaceAll("\r", "\\r")
    if (displayArgs.length > 150) {
      displayArgs = `${displayArgs.slice(0, 150)}... (已截断)`
    }
    console.log(`   参数: ${displayArgs}`)
  }

  async onToolResult(
    _ctx: AbortSignal | undefined,
    toolName: string,
    result: string,
    isError: boolean,
  ): Promise<void> {
    if (isError) {
      console.log(`[❌ 执行失败] ${toolName}`)
      // 显示错误信息
      if (result !== "") {
        console.log(`   错误: ${result}`)
      }
    } else {
      console.log(`[✅ 执行成功] ${toolName}`)
    }
  }

  async onMessage(
    _ctx: AbortSignal | undefined,
    content: string,
  ): Promise<void> {
    if (content === "") {
      return
    }
    console.log(`\n🤖 Agent 回复:\n${content}\n`)
  }
}

/** 工厂：对应 Go 的 NewTerminalReporter */
export function createTerminalReporter(): TerminalReporter {
  return new TerminalReporter()
}

// 编译时类型检查：确保 TerminalReporter 实现了 Reporter 接口
// 对应 Go 风格的接口满足断言
const _terminalReporterTypeCheck: Reporter =
  null as unknown as TerminalReporter
void _terminalReporterTypeCheck
