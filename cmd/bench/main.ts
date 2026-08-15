/* npx tsx cmd/bench/main.ts */
// 对应 Go: cmd/bench/main.go
//
// 微型评测集入口：文本替换题 + 代码分析与生成题。

import { existsSync } from "node:fs"
import path from "node:path"

import {
  createBenchmarkRunner,
  type TestCase,
} from "../../internal/eval/benchmark.ts"
import { error as logError } from "../../internal/log/log.ts"

/** Node 不会自动读 .env，启动时从工作区根目录加载 */
function loadDotEnv(): void {
  const envPath = path.resolve(process.cwd(), ".env")
  if (!existsSync(envPath)) return
  process.loadEnvFile(envPath)
}

loadDotEnv()

/** 构建一套微型评测集 */
const testcases: TestCase[] = [
  {
    id: "test_001_edit",
    name: "测试模糊替换工具的准确性",
    // 准备靶机：生成一个有错误的 json 文件
    setupScript: `echo '{"name": "tiny-claw", "version": "v1.0.0"}' > config.json`,
    // 考题：要求修改版本号
    taskPrompt: `当前目录下有一个 config.json。请你使用 edit_file 工具，将其中的 version 从 v1.0.0 改为 v2.0.0。不要做其他多余操作。`,
    // 判卷脚本：使用 grep 检查文件是否包含 v2.0.0
    validateScript: `grep '"version": "v2.0.0"' config.json`,
    maxTurns: 10,
  },
  {
    id: "test_002_code_gen",
    name: "测试代码阅读与创建新文件的综合能力",
    // 准备靶机：生成一个简单的乘法函数
    setupScript: `cat > math.js << 'EOF'
function multiply(a, b) {
  return a * b
}

module.exports = { multiply }
EOF`,
    // 考题：要求 Agent 根据刚才的代码，自己去写一份单元测试
    taskPrompt: `当前目录下有一个 math.js。请你仔细阅读它，然后在同级目录下，帮我写一个规范的单元测试文件 math.test.js，用来测试 multiply 函数。请使用 Node.js 内置的 node:test 和 node:assert，务必包含正常的测试用例。`,
    // 判卷脚本：直接运行 node --test！如果不通过则直接 0 分。
    validateScript: `node --test math.test.js`,
    maxTurns: 10,
  },
]

async function main(): Promise<void> {
  // Go 检查 ZHIPU_API_KEY；本仓库统一用 OpenAI 兼容的 LLM_*
  if (!process.env.LLM_API_KEY) {
    logError("请先设置 LLM_API_KEY 环境变量进行跑分测试（可写在项目根目录 .env）")
    process.exit(1)
  }
  if (!process.env.LLM_BASE_URL) {
    logError("请先设置 LLM_BASE_URL 环境变量进行跑分测试（可写在项目根目录 .env）")
    process.exit(1)
  }

  // 启动跑分执行器！
  // 我们选用国内极其廉价但能力不错的 glm-4.5-air 跑分，省点钱。
  const model = process.env.LLM_MODEL ?? "glm-4.5-air"
  const runner = createBenchmarkRunner(model)
  await runner.runSuite(undefined, testcases)
}

try {
  await main()
} catch (err) {
  logError("跑分启动失败:", err)
  process.exit(1)
}
