/* npx tsx cmd/claw/main.ts  */

import { existsSync } from "node:fs"
import path from "node:path"

import { AgentEngine } from "../../internal/engine/loop.ts"
import { error as logError } from "../../internal/log/log.ts"
import { createOpenAIProvider } from "../../internal/provider/openai.ts"
// 也可换成 Claude 兼容端点：createClaudeProvider from "../../internal/provider/claude.ts"
import { createBashTool } from "../../internal/tools/bash.ts"
import { createReadFileTool } from "../../internal/tools/read-file.ts"
import { createRegistry } from "../../internal/tools/registry.ts"
import { createWriteFileTool } from "../../internal/tools/write-file.ts"

/** Node 不会自动读 .env，启动时从工作区根目录加载 */
function loadDotEnv(): void {
  const envPath = path.resolve(process.cwd(), ".env")
  if (!existsSync(envPath)) return
  process.loadEnvFile(envPath)
}

loadDotEnv()

async function main() {
  if (!process.env.LLM_API_KEY) {
    logError("请先设置 LLM_API_KEY 环境变量（可写在项目根目录 .env）")
    process.exit(1)
  }
  if (!process.env.LLM_BASE_URL) {
    logError("请先设置 LLM_BASE_URL 环境变量（可写在项目根目录 .env）")
    process.exit(1)
  }

  const workDir = process.cwd()

  const model = process.env.LLM_MODEL ?? "glm-4.5-air"
  const llmProvider = createOpenAIProvider(model)
  const registry = createRegistry()

  // 挂载极简工具集
  registry.register(createReadFileTool(workDir))
  registry.register(createWriteFileTool(workDir))
  registry.register(createBashTool(workDir))

  // 实例化核心引擎，关闭慢思考阶段，享受 YOLO 急速模式
  const eng = new AgentEngine(llmProvider, registry, workDir, false)

  // 发起一个需要连贯物理动作的任务
  const prompt = `
    请帮我执行以下操作：
    1. 用 bash 查看一下我当前电脑的 Node 版本。
    2. 帮我写一个简单的 helloworld.js 文件，输出 "Hello, ts-tiny-claw!"。
    3. 用 bash 运行这个 js 文件，确认它能正常工作。
    `

  try {
    await eng.run(undefined, prompt)
  } catch (err) {
    logError("引擎运行崩溃:", err)
    process.exit(1)
  }
}

await main()
