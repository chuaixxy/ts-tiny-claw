import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"

import type { ToolDefinition } from "../schema/message.ts"
import type { BaseTool } from "./registry.ts"

/** 内部定义用于反序列化的参数结构 */
interface EditFileArgs {
  path: string
  old_text: string
  new_text: string
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle === "") return 0
  return haystack.split(needle).length - 1
}

/**
 * fuzzyReplace 实现了四级容错降级替换算法：
 * L1 精确匹配 → L2 换行归一化 → L3 TrimSpace → L4 逐行去缩进滑动窗口
 */
function fuzzyReplace(
  originalContent: string,
  oldText: string,
  newText: string,
): string {
  // L1: 精确匹配
  let count = countOccurrences(originalContent, oldText)
  if (count === 1) {
    return originalContent.replace(oldText, newText)
  }
  if (count > 1) {
    throw new Error(
      `old_text 匹配到了 ${count} 处，请提供更多的上下文代码以确保唯一性`,
    )
  }

  // L2: 换行符归一化 (统一将 \r\n 转换为 \n)
  const normalizedContent = originalContent.replaceAll("\r\n", "\n")
  const normalizedOld = oldText.replaceAll("\r\n", "\n")

  count = countOccurrences(normalizedContent, normalizedOld)
  if (count === 1) {
    return normalizedContent.replace(normalizedOld, newText)
  }

  // L3: Trim Space 匹配 (忽略首尾的空行和空格)
  const trimmedOld = normalizedOld.trim()
  if (trimmedOld !== "") {
    count = countOccurrences(normalizedContent, trimmedOld)
    if (count === 1) {
      // 触发 L3/L4 时，若 newText 缩进不完整，格式可能不美观，但优于直接报错死循环
      return normalizedContent.replace(trimmedOld, newText)
    }
  }

  // L4: 逐行去缩进匹配
  return lineByLineReplace(normalizedContent, normalizedOld, newText)
}

/** 将文本按行切割，去除首尾空白后进行滑动窗口匹配 */
function lineByLineReplace(content: string, oldText: string, newText: string): string {
  const contentLines = content.split("\n")
  const oldLines = oldText
    .trim()
    .split("\n")
    .map((line) => line.trim())

  if (oldLines.length === 0 || contentLines.length < oldLines.length) {
    throw new Error("找不到该代码片段")
  }

  let matchCount = 0
  let matchStartIndex = -1
  let matchEndIndex = -1

  for (let i = 0; i <= contentLines.length - oldLines.length; i++) {
    let isMatch = true
    for (let j = 0; j < oldLines.length; j++) {
      if (contentLines[i + j]!.trim() !== oldLines[j]) {
        isMatch = false
        break
      }
    }

    if (isMatch) {
      matchCount++
      matchStartIndex = i
      matchEndIndex = i + oldLines.length
    }
  }

  if (matchCount === 0) {
    throw new Error(
      "在文件中未找到 old_text，请大模型先调用 read_file 仔细确认文件内容和缩进",
    )
  }
  if (matchCount > 1) {
    throw new Error(
      `模糊匹配到了 ${matchCount} 处相似代码，请提供更多上下行代码以精确定位`,
    )
  }

  const newContentLines = [
    ...contentLines.slice(0, matchStartIndex),
    newText,
    ...contentLines.slice(matchEndIndex),
  ]

  return newContentLines.join("\n")
}

/** EditFileTool 对现有文件做局部字符串替换 */
export class EditFileTool implements BaseTool {
  private readonly workDir: string

  constructor(workDir: string) {
    this.workDir = workDir
  }

  name(): string {
    return "edit_file"
  }

  definition(): ToolDefinition {
    return {
      name: this.name(),
      description:
        "对现有文件进行局部的字符串替换。这比重写整个文件更安全、更快速。请提供足够的 old_text 上下文以确保匹配的唯一性。",
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "要修改的文件路径",
          },
          old_text: {
            type: "string",
            description:
              "文件中原有的文本。必须包含足够的上下文（建议上下各多包含几行），以确保在文件中的唯一性。",
          },
          new_text: {
            type: "string",
            description: "要替换成的新文本",
          },
        },
        required: ["path", "old_text", "new_text"],
      },
    }
  }

  async execute(_ctx: AbortSignal | undefined, args: Uint8Array): Promise<string> {
    let input: EditFileArgs
    try {
      const parsed: unknown = JSON.parse(new TextDecoder().decode(args))
      if (
        !parsed ||
        typeof parsed !== "object" ||
        typeof (parsed as EditFileArgs).path !== "string" ||
        typeof (parsed as EditFileArgs).old_text !== "string" ||
        typeof (parsed as EditFileArgs).new_text !== "string"
      ) {
        throw new Error("缺少必填字段 path/old_text/new_text，或类型不正确")
      }
      input = parsed as EditFileArgs
    } catch (err) {
      throw new Error(
        `参数解析失败: ${err instanceof Error ? err.message : String(err)}`,
      )
    }

    const fullPath = path.join(this.workDir, input.path)

    // 1. 读取原文件内容
    let originalContent: string
    try {
      originalContent = await readFile(fullPath, "utf8")
    } catch (err) {
      throw new Error(
        `读取文件失败，请确认路径是否正确: ${err instanceof Error ? err.message : String(err)}`,
      )
    }

    // 2. 调用多级模糊替换算法
    // 【驾驭哲学】将具体的报错原因 (如匹配到多处) 原样抛出，让大模型自行纠正
    const newContent = fuzzyReplace(originalContent, input.old_text, input.new_text)

    // 3. 将新内容安全地写回磁盘
    try {
      await writeFile(fullPath, newContent, { mode: 0o644 })
    } catch (err) {
      throw new Error(
        `写回文件失败: ${err instanceof Error ? err.message : String(err)}`,
      )
    }

    return `✅ 成功修改文件: ${input.path}`
  }
}

/** 创建 edit_file 工具实例 */
export function createEditFileTool(workDir: string): EditFileTool {
  return new EditFileTool(workDir)
}
