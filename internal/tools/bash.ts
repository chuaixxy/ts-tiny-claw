import { execFile } from "node:child_process"
import { promisify } from "node:util"

import type { ToolDefinition } from "../schema/message.ts"
import type { BaseTool } from "./registry.ts"

const execFileAsync = promisify(execFile)

/** 内部定义用于反序列化的参数结构 */
interface BashArgs {
  command: string
}

const EXEC_TIMEOUT_MS = 30_000
const MAX_OUTPUT_LEN = 8000

/** BashTool 将大模型生成的命令原封不动交给底层 OS 执行 */
export class BashTool implements BaseTool {
  /** 工作区约束：命令默认在此目录下执行 */
  private readonly workDir: string

  constructor(workDir: string) {
    this.workDir = workDir
  }

  name(): string {
    return "bash"
  }

  definition(): ToolDefinition {
    return {
      name: this.name(),
      description:
        "在当前工作区执行任意的 bash 命令。支持链式命令(如 &&)。返回标准输出(stdout)和标准错误(stderr)。",
      inputSchema: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "要执行的 bash 命令，例如: ls -la 或 npm test",
          },
        },
        required: ["command"],
      },
    }
  }

  async execute(ctx: AbortSignal | undefined, args: Uint8Array): Promise<string> {
    let input: BashArgs
    try {
      const parsed: unknown = JSON.parse(new TextDecoder().decode(args))
      if (
        !parsed ||
        typeof parsed !== "object" ||
        typeof (parsed as BashArgs).command !== "string"
      ) {
        throw new Error("缺少必填字段 command，或类型不正确")
      }
      input = parsed as BashArgs
    } catch (err) {
      throw new Error(
        `参数解析失败: ${err instanceof Error ? err.message : String(err)}`,
      )
    }

    // 【驾驭底线 1】：Time Budgeting — 最大执行时间，防止卡死进程
    // 【驾驭底线 2】：绑定 WorkDir；确保命令默认在用户指定的 WorkDir 下执行，而不是引擎启动时的绝对路径。
    let outputStr = ""
    let timedOut = false
    let execErr: unknown

    try {
      //  在 macOS/Linux 下，我们通过将指令包裹在 `bash -c` 中执行，以支持环境变量、管道和逻辑与(&&)等复杂 Shell 语法。
      const { stdout, stderr } = await execFileAsync("bash", ["-c", input.command], {
        cwd: this.workDir,
        timeout: EXEC_TIMEOUT_MS,
        signal: ctx,
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
      })
      outputStr = `${stdout}${stderr}`
    } catch (err) {
      execErr = err
      const e = err as NodeJS.ErrnoException & {
        stdout?: string
        stderr?: string
        killed?: boolean
        signal?: NodeJS.Signals | number | null
      }
      outputStr = `${e.stdout ?? ""}${e.stderr ?? ""}`
      // timeout / abort 时进程会被 kill
      timedOut = Boolean(e.killed) || e.signal === "SIGTERM"
    }

    if (timedOut) {
      return (
        outputStr +
        "\n[警告: 命令执行超时(30s)，已被系统强制终止。如果是启动常驻服务，请尝试将其转入后台。]"
      )
    }

    // 【驾驭底线 3】：错误原样回传 — 不抛错，交给模型自纠
    if (execErr != null) {
      const msg = execErr instanceof Error ? execErr.message : String(execErr)
      return `执行报错: ${msg}\n输出:\n${outputStr}`
    }

    if (outputStr === "") {
      return "命令执行成功，无终端输出。"
    }

    // 【驾驭底线 4】：长度截断保护 (防 OOM)
    if (outputStr.length > MAX_OUTPUT_LEN) {
      return `${outputStr.slice(0, MAX_OUTPUT_LEN)}\n\n...[终端输出过长，已截断至前 ${MAX_OUTPUT_LEN} 字节]...`
    }

    return outputStr
  }
}

/** 创建 bash 工具实例 */
export function createBashTool(workDir: string): BashTool {
  return new BashTool(workDir)
}
