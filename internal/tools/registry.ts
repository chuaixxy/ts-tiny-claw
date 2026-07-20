import type { ToolDefinition, ToolResult } from "../provider/schema"

/** 单个工具的执行契约 */
export interface Tool {
  /** 工具名称，与 ToolDefinition.name 保持一致 */
  name(): string
  /** 工具描述及入参 Schema，用于向模型声明能力 */
  definition(): ToolDefinition
  /** 执行工具，入参为模型传入的 JSON 对象，返回执行结果 */
  execute(input: unknown): Promise<ToolResult>
}

/** 工具注册表，管理所有可用工具的注册与查询 */
export interface Registry {
  /** 注册一个工具 */
  register(tool: Tool): void
  /** 按名称查询工具，不存在时返回 undefined */
  get(name: string): Tool | undefined
  /** 返回所有工具的定义列表，用于传递给大模型 */
  definitions(): ToolDefinition[]
}

/** 默认注册表实现 */
export class ToolRegistry implements Registry {
  private tools = new Map<string, Tool>()

  register(tool: Tool): void {
    this.tools.set(tool.name(), tool)
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name)
  }

  definitions(): ToolDefinition[] {
    return Array.from(this.tools.values()).map(t => t.definition())
  }
}
