/* npx tsx cmd/claw/main.ts  */

import { existsSync } from "node:fs"
import path from "node:path"

import { AgentEngine } from "../../internal/engine/loop.ts"
import { error as logError } from "../../internal/log/log.ts"
import { createOpenAIProvider } from "../../internal/provider/openai.ts"
// 也可换成 Claude 兼容端点：createClaudeProvider from "../../internal/provider/claude.ts"
import { createBashTool } from "../../internal/tools/bash.ts"
import { createEditFileTool } from "../../internal/tools/edit-file.ts"
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
  registry.register(createReadFileTool(workDir))
  // 挂载其他的极简工具
  registry.register(createWriteFileTool(workDir))
  registry.register(createBashTool(workDir))
  registry.register(createEditFileTool(workDir))

  // 实例化引擎，开启 EnableThinking = true (开启慢思考，促使模型一次性统筹规划)
  const eng = new AgentEngine(llmProvider, registry, workDir, true)

  // 下发一个需要收集多源信息的任务
  const prompt = `
    我当前目录下有 a.txt, b.txt, c.txt 三个文件。
    为了节省时间，请你同时一次性读取这三个文件，并将它们的内容综合起来，告诉我它们分别记录了什么领域的信息。
    `

  try {
    await eng.run(undefined, prompt)
  } catch (err) {
    logError("引擎运行崩溃:", err)
    process.exit(1)
  }
}

await main()
