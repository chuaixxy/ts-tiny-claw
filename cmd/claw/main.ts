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

  // 挂载工具全家桶
  registry.register(createReadFileTool(workDir))
  registry.register(createWriteFileTool(workDir))
  registry.register(createBashTool(workDir))
  // 【新增挂载】
  registry.register(createEditFileTool(workDir))

  // 实例化引擎（EnableThinking = false）
  const eng = new AgentEngine(llmProvider, registry, workDir, false)

  // 发起一个需要局部修改的指令
  const prompt = `
    我当前目录下有一个 server.ts 文件。
    请帮我把里面 "TODO: 增加鉴权逻辑" 下面的那个 if 语句，整个替换为：
    if (user == null) {
      console.log("Forbidden!");
      return;
    }
    `

  try {
    await eng.run(undefined, prompt)
  } catch (err) {
    logError("引擎运行崩溃:", err)
    process.exit(1)
  }
}

await main()
