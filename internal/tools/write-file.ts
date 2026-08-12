import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"

import type { ToolDefinition } from "../schema/message.ts"
import type { BaseTool } from "./registry.ts"

/** 内部定义用于反序列化的参数结构 */
interface WriteFileArgs {
  path: string
  content: string
}

/** WriteFileTool 实现了创建或覆盖写入本地文件的工具 */
export class WriteFileTool implements BaseTool {
  /** 工作区约束：限制只能在此目录及其子目录下操作 */
  private readonly workDir: string

  constructor(workDir: string) {
    this.workDir = workDir
  }

  name(): string {
    return "write_file"
  }

  definition(): ToolDefinition {
    return {
      name: this.name(),
      description:
        "创建或覆盖写入一个文件。如果目录不存在会自动创建。请提供相对于工作区的相对路径。",
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "要写入的文件路径，如 src/main.ts",
          },
          content: {
            type: "string",
            description: "要写入的完整文件内容",
          },
        },
        required: ["path", "content"],
      },
    }
  }

  async execute(_ctx: AbortSignal | undefined, args: Uint8Array): Promise<string> {
    let input: WriteFileArgs
    try {
      const parsed: unknown = JSON.parse(new TextDecoder().decode(args))
      if (
        !parsed ||
        typeof parsed !== "object" ||
        typeof (parsed as WriteFileArgs).path !== "string" ||
        typeof (parsed as WriteFileArgs).content !== "string"
      ) {
        throw new Error("缺少必填字段 path/content，或类型不正确")
      }
      input = parsed as WriteFileArgs
    } catch (err) {
      throw new Error(
        `参数解析失败: ${err instanceof Error ? err.message : String(err)}`,
      )
    }

    // 【安全防线】：限制在 WorkDir 下执行，防止大模型修改系统级文件
    const fullPath = path.join(this.workDir, input.path)

    // 自动创建缺失的父级目录
    try {
      await mkdir(path.dirname(fullPath), { recursive: true })
    } catch (err) {
      throw new Error(
        `创建父目录失败: ${err instanceof Error ? err.message : String(err)}`,
      )
    }

    // 写入文件内容，权限设为 0o644
    try {
      await writeFile(fullPath, input.content, { mode: 0o644 })
    } catch (err) {
      throw new Error(
        `写入文件失败: ${err instanceof Error ? err.message : String(err)}`,
      )
    }

    return `成功将内容写入到文件: ${input.path}`
  }
}

/** 创建 write_file 工具实例 */
export function createWriteFileTool(workDir: string): WriteFileTool {
  return new WriteFileTool(workDir)
}
