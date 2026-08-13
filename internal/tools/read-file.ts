import { readFile } from "node:fs/promises"
import path from "node:path"

import { getActiveWorkDir } from "../engine/workdir-context.ts"
import type { ToolDefinition } from "../schema/message.ts"
import type { BaseTool } from "./registry.ts"

/** 内部定义用于反序列化的参数结构 */
interface ReadFileArgs {
  path: string
}

/** ReadFileTool 实现了读取本地文件内容的工具 */
export class ReadFileTool implements BaseTool {
  /** 将引擎的 WorkDir 注入给工具，限制它只能在此目录及其子目录下操作 */
  private readonly workDir: string

  constructor(workDir: string) {
    this.workDir = workDir
  }

  name(): string {
    return "read_file"
  }

  /** 向大模型清晰地描述这个工具的用途和参数格式 */
  definition(): ToolDefinition {
    return {
      name: this.name(),
      description: "读取指定路径的文件内容。请提供相对工作区的路径。",
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "要读取的文件路径，如 cmd/claw/main.ts",
          },
        },
        required: ["path"],
      },
    }
  }

  async execute(_ctx: AbortSignal | undefined, args: Uint8Array): Promise<string> {
    // 1. 延迟解析：将大模型传过来的 JSON 参数解析为强类型结构
    let input: ReadFileArgs
    try {
      const parsed: unknown = JSON.parse(new TextDecoder().decode(args))
      if (
        !parsed ||
        typeof parsed !== "object" ||
        typeof (parsed as ReadFileArgs).path !== "string"
      ) {
        throw new Error("缺少必填字段 path，或类型不正确")
      }
      input = parsed as ReadFileArgs
    } catch (err) {
      // 返回 error 会被 Registry 捕获并传给大模型，模型会知道自己 JSON 格式写错了
      throw new Error(
        `参数解析失败: ${err instanceof Error ? err.message : String(err)}`,
      )
    }

    // 2. 拼接绝对路径 (注意：生产环境中需要做路径穿越检测防范，防止 ../../etc/passwd)
    // 活跃工作区跟随当前 Session（对应 Go: session.WorkDir）
    const fullPath = path.join(getActiveWorkDir(this.workDir), input.path)

    // 3. 执行物理 IO 操作
    let content: Buffer
    try {
      content = await readFile(fullPath)
    } catch (err) {
      throw new Error(
        `打开/读取文件失败: ${err instanceof Error ? err.message : String(err)}`,
      )
    }

    // 4. 【核心防线】长度截断保护
    // 为了防止大模型读取几百 MB 的日志文件导致 Context 瞬间爆炸 (OOM)，
    // 我们在工具内部直接进行物理截断。
    const maxLen = 8000
    if (content.length > maxLen) {
      return `${content.subarray(0, maxLen).toString("utf8")}\n\n...[由于内容过长，已被系统截断至前 ${maxLen} 字节]...`
    }

    return content.toString("utf8")
  }
}

/** 创建 read_file 工具实例 */
export function createReadFileTool(workDir: string): ReadFileTool {
  return new ReadFileTool(workDir)
}
