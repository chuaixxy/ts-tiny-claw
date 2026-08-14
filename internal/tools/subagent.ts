// internal/tools/subagent.ts
// 对应 Go: internal/tools/subagent.go
//
// 套娃拉起子智能体：通过 AgentRunner 抽象打破 tools ↔ engine 循环依赖。
// 子智能体只挂载只读 Registry，限制爆炸半径（Blast Radius）。

import { log } from "../log/log.ts"
import type { ToolDefinition } from "../schema/message.ts"
import type { BaseTool, Registry } from "./registry.ts"

/**
 * AgentRunner 是一个打破循环依赖的抽象接口。
 * 因为 SubagentTool 存在于 tools 包，而完整的 AgentEngine 存在于 engine 包。
 * 为了让 Tool 能拉起 Engine，我们定义一个接口供外部注入。
 */
export interface AgentRunner {
  /**
   * RunSub 启动一个匿名的、一次性的子智能体任务，
   * 并返回其最终梳理出的纯文本总结。
   */
  runSub(
    ctx: AbortSignal | undefined,
    taskPrompt: string,
    readOnlyRegistry: Registry,
    reporter: unknown,
  ): Promise<string>
}

/** 内部定义用于反序列化的参数结构 */
interface SubagentArgs {
  task_prompt: string
}

/**
 * SubagentTool：主 Agent 通过 spawn_subagent 派出只读探索子智能体。
 * 初始化时注入 runner + 受限的只读 Registry（通常只有 read_file、bash）。
 */
export class SubagentTool implements BaseTool {
  private readonly runner: AgentRunner
  /** 为子智能体准备的专属、受限的“只读”注册表 */
  private readonly readOnlyRegistry: Registry
  /** 暂时用 unknown 规避包循环依赖，底层通过断言使用 */
  private readonly reporter: unknown

  constructor(
    runner: AgentRunner,
    readOnlyRegistry: Registry,
    reporter: unknown,
  ) {
    this.runner = runner
    this.readOnlyRegistry = readOnlyRegistry
    this.reporter = reporter
  }

  name(): string {
    return "spawn_subagent"
  }

  /** Definition 向主 Agent 暴露这个工具的强大能力 */
  definition(): ToolDefinition {
    return {
      name: this.name(),
      description:
        "派出一个专门用于深度探索（Exploration）的子智能体。当你需要阅读大量代码、跨文件查找逻辑时请调用此工具。它在探索完毕后，会给你返回一份极度精炼的摘要报告。",
      inputSchema: {
        type: "object",
        properties: {
          task_prompt: {
            type: "string",
            description: "给子智能体下达的明确指令。",
          },
        },
        required: ["task_prompt"],
      },
    }
  }

  async execute(
    ctx: AbortSignal | undefined,
    args: Uint8Array,
  ): Promise<string> {
    let input: SubagentArgs
    try {
      const parsed: unknown = JSON.parse(new TextDecoder().decode(args))
      if (
        !parsed ||
        typeof parsed !== "object" ||
        typeof (parsed as SubagentArgs).task_prompt !== "string"
      ) {
        throw new Error("缺少必填字段 task_prompt，或类型不正确")
      }
      input = parsed as SubagentArgs
    } catch (err) {
      throw new Error(
        `解析参数失败: ${err instanceof Error ? err.message : String(err)}`,
      )
    }

    log(
      `[Subagent] 🚀 主 Agent 发起委派！正在拉起探路者: [${input.task_prompt}]...`,
    )

    // 【核心降维打击】：拉起一个完全物理隔离的子循环
    // 我们把针对该任务的专项指令传给子智能体，并仅提供 readOnlyRegistry。
    // (子智能体只能读文件或执行只读的 bash，不能搞破坏)
    // await 会挂起当前工具调用（不阻塞事件循环），直到子 ReAct 跑完——语义对齐 Go 的同步阻塞。
    let summary: string
    try {
      summary = await this.runner.runSub(
        ctx,
        input.task_prompt,
        this.readOnlyRegistry,
        this.reporter,
      )
    } catch (err) {
      // 对应 Go: return fmt.Errorf("子智能体执行失败: %v", err).Error(), nil
      // 把失败写成普通输出返回，避免 Registry 再包一层 Error executing…
      return `子智能体执行失败: ${err instanceof Error ? err.message : String(err)}`
    }

    log("[Subagent] ✅ 子智能体任务结束。报告返回给主干...")

    // 最终，几万字的代码探索，化作了这一段轻量级的 Summary，
    // 就像一次普通的 API 调用一样，返回给了始终保持清醒的主 Agent。
    return `【子智能体探索报告】:\n${summary}`
  }
}

/** 工厂：对应 Go 的 NewSubagentTool */
export function createSubagentTool(
  runner: AgentRunner,
  readOnlyRegistry: Registry,
  reporter: unknown,
): SubagentTool {
  return new SubagentTool(runner, readOnlyRegistry, reporter)
}
