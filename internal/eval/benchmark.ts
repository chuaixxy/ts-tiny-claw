// internal/eval/benchmark.ts
// 对应 Go: internal/eval/benchmark.go
//
// 评测模块：定义测试任务，并为每个用例分配干净工作区与 CostTracker 包裹的引擎。

import { execFile } from "node:child_process"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { promisify } from "node:util"

import { AgentEngine } from "../engine/loop.ts"
import type { Reporter } from "../engine/reporter.ts"
import { createSession } from "../engine/session.ts"
import { log } from "../log/log.ts"
import { createCostTracker } from "../observability/tracker.ts"
import { createOpenAIProvider } from "../provider/openai.ts"
import { createBashTool } from "../tools/bash.ts"
import { createEditFileTool } from "../tools/edit-file.ts"
import { createReadFileTool } from "../tools/read-file.ts"
import { createRegistry } from "../tools/registry.ts"
import { createWriteFileTool } from "../tools/write-file.ts"

const execFileAsync = promisify(execFile)

/** TestCase 定义了一个需要 Agent 去完成并验证的独立任务 */
export interface TestCase {
  /** 用例唯一标识 */
  id: string
  /** 用例名称 */
  name: string
  /** 【可选】在 Agent 运行前执行的 bash 脚本 (用于初始化靶机代码) */
  setupScript?: string
  /** 发送给 Agent 的任务指令 */
  taskPrompt: string
  /** 【核心】在 Agent 运行结束后执行的 bash 校验脚本。exit 0 视为成功，其他视为失败 */
  validateScript: string
  /** 允许 Agent 尝试的最大轮数 (超时算失败) */
  maxTurns: number
}

/** TestResult 存放单次跑分结果 */
export interface TestResult {
  testCaseId: string
  passed: boolean
  /** 对齐 Session.totalCostCNY（Tracker 按人民币记账） */
  totalCostCNY: number
  durationMs: number
  errorMsg: string
}

/**
 * 空 Reporter：屏蔽思考 / 工具 / 回复的普通日志，防止评测刷屏。
 * 对应 Go: eng.Run(ctx, session, nil)
 */
const silentReporter: Reporter = {
  onThinking() {},
  onToolCall() {},
  onToolResult() {},
  onMessage() {},
}

type ExecError = Error & { stdout?: string; stderr?: string }

/** 在指定工作区执行一段 bash 脚本；exit 0 视为成功 */
async function runBashScript(
  script: string,
  cwd: string,
): Promise<{ ok: boolean; output: string }> {
  try {
    const { stdout, stderr } = await execFileAsync("bash", ["-c", script], {
      cwd,
      encoding: "utf8",
    })
    return { ok: true, output: `${stdout ?? ""}${stderr ?? ""}` }
  } catch (err) {
    const e = err as ExecError
    return {
      ok: false,
      output: `${e.stdout ?? ""}${e.stderr ?? ""}` || e.message,
    }
  }
}

/** BenchmarkRunner 遍历评测集，为每个用例拉起隔离的 Agent */
export class BenchmarkRunner {
  private readonly modelName: string

  constructor(model: string) {
    this.modelName = model
  }

  /** RunSuite 执行一组评测集，打印跑分报告并返回各用例结果 */
  async runSuite(
    ctx: AbortSignal | undefined,
    testcases: TestCase[],
  ): Promise<TestResult[]> {
    log("==================================================")
    log(`🚀 启动自动化 Harness Benchmark 评估... | 模型: ${this.modelName}`)
    log("==================================================")

    const results: TestResult[] = []
    let passedCount = 0
    let totalCost = 0

    for (const tc of testcases) {
      log(`\n>>> ⏳ 正在执行用例 [${tc.id}]: ${tc.name}`)

      const res = await this.runSingleTest(ctx, tc)
      results.push(res)

      if (res.passed) {
        passedCount++
        log(
          `>>> ✅ 用例 [${tc.id}] 测试通过! | 耗时: ${res.durationMs}ms | 花费: $${res.totalCostCNY.toFixed(6)}`,
        )
      } else {
        log(`>>> ❌ 用例 [${tc.id}] 测试失败! | 错误: ${res.errorMsg}`)
      }
      totalCost += res.totalCostCNY
    }

    const rate =
      testcases.length === 0 ? 0 : (passedCount / testcases.length) * 100

    log("\n================ 🏆 跑分终极报告 ================")
    log(
      `总用例数: ${testcases.length} | 成功数: ${passedCount} | 成功率: ${rate.toFixed(2)}%`,
    )
    log(`总消耗成本: $${totalCost.toFixed(6)}`)
    log("==================================================")

    return results
  }

  private async runSingleTest(
    ctx: AbortSignal | undefined,
    tc: TestCase,
  ): Promise<TestResult> {
    const startTime = Date.now()

    // 1. 为每个用例创建一个绝对干净的沙箱目录 (物理隔离)
    const workDir = path.join(
      process.cwd(),
      "workspace",
      `${tc.id}_${Math.floor(Date.now() / 1000)}`,
    )
    await mkdir(workDir, { recursive: true })

    // 2. (可选) 执行 Setup 脚本准备靶机代码
    if (tc.setupScript) {
      const setup = await runBashScript(tc.setupScript, workDir)
      if (!setup.ok) {
        return {
          testCaseId: tc.id,
          passed: false,
          totalCostCNY: 0,
          durationMs: 0,
          errorMsg: "靶机 Setup 失败",
        }
      }
    }

    // 3. 组装具备打点能力 (Tracker) 的引擎
    const realProvider = createOpenAIProvider(this.modelName)
    const session = createSession(tc.id, workDir)
    const trackedProvider = createCostTracker(
      realProvider,
      this.modelName,
      session,
    )

    const registry = createRegistry()
    registry.register(createReadFileTool(workDir))
    registry.register(createWriteFileTool(workDir))
    registry.register(createBashTool(workDir))
    registry.register(createEditFileTool(workDir))

    const eng = new AgentEngine(trackedProvider, registry, false, false)

    // 4. 让 Agent 开始干活
    session.append({ role: "user", content: tc.taskPrompt })
    try {
      await eng.run(ctx, session, silentReporter)
    } catch (err) {
      return {
        testCaseId: tc.id,
        passed: false,
        totalCostCNY: session.totalCostCNY,
        durationMs: Date.now() - startTime,
        errorMsg: `Agent 崩溃: ${err instanceof Error ? err.message : String(err)}`,
      }
    }

    // 5. 【核心断言】Agent 跑完了，我们来验收成果！
    const validate = await runBashScript(tc.validateScript, workDir)
    const durationMs = Date.now() - startTime

    if (!validate.ok) {
      return {
        testCaseId: tc.id,
        passed: false,
        totalCostCNY: session.totalCostCNY,
        durationMs,
        errorMsg: `验证脚本执行失败: ${validate.output}`,
      }
    }

    return {
      testCaseId: tc.id,
      passed: true,
      totalCostCNY: session.totalCostCNY,
      durationMs,
      errorMsg: "",
    }
  }
}

/** 工厂：对应 Go 的 NewBenchmarkRunner */
export function createBenchmarkRunner(model: string): BenchmarkRunner {
  return new BenchmarkRunner(model)
}
