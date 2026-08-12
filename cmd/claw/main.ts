/* npx tsx cmd/claw/main.ts  */

import { existsSync } from "node:fs"
import path from "node:path"

import { AgentEngine } from "../../internal/engine/loop.ts"
import { createOpenAIProvider } from "../../internal/provider/openai.ts"
// 也可换成 Claude 兼容端点：createClaudeProvider from "../../internal/provider/claude.ts"
import { createReadFileTool } from "../../internal/tools/read-file.ts"
import { createRegistry } from "../../internal/tools/registry.ts"

/** Node 不会自动读 .env，启动时从工作区根目录加载 */
function loadDotEnv(): void {
  const envPath = path.resolve(process.cwd(), ".env")
  if (!existsSync(envPath)) return
  process.loadEnvFile(envPath)
}

loadDotEnv()

async function main() {
  if (!process.env.LLM_API_KEY) {
    console.error("请先设置 LLM_API_KEY 环境变量（可写在项目根目录 .env）")
    process.exit(1)
  }
  if (!process.env.LLM_BASE_URL) {
    console.error("请先设置 LLM_BASE_URL 环境变量（可写在项目根目录 .env）")
    process.exit(1)
  }

  // 1. 获取工作区物理边界
  const workDir = process.cwd()

  // 2. 初始化真实的大脑（任意 OpenAI 兼容端点：智谱 / DeepSeek / 豆包等）
  const model = process.env.LLM_MODEL ?? "glm-4.5-air"
  const llmProvider = createOpenAIProvider(model)

  // 3. 初始化真实的 Tool Registry
  const registry = createRegistry()

  // 4. 将真实的 ReadFile 工具挂载到注册表中
  registry.register(createReadFileTool(workDir))

  // 5. 实例化核心引擎，由于任务简单，关闭思考阶段以加快速度
  const eng = new AgentEngine(llmProvider, registry, workDir, false)

  // 6. 下发一个必须通过真实工具才能完成的任务
  const prompt =
    "请调用工具读取一下当前工作区目录下 hello.txt 文件的内容，并用一句话向我总结它说了什么。"

  try {
    await eng.run(undefined, prompt)
  } catch (err) {
    console.error("引擎运行崩溃:", err)
    process.exit(1)
  }
}

await main()
