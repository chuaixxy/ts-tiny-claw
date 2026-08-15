# ts-tiny-claw

`go-tiny-claw` 的 TypeScript / Node 实现：一个可在终端和飞书里跑起来的微型 Agent Harness。

核心是 ReAct Main Loop，外加 Session 隔离、工具 Middleware、飞书人工审批、意图拦截、Token 账单和 Tracing。AgentOps 入口把这些拼成运维小助手：只读操作 YOLO 放行，改文件 / `nginx -s reload` 等会挂起，等人在群里 `approve <taskID>`。

## 能力一览

| 层 | 做什么 |
|---|---|
| Engine | ReAct 循环、Working Memory、死循环 Reminder、错误 Recovery |
| Tools | `read_file` / `write_file` / `edit_file` / `bash`，可选 Subagent |
| 安全 | Registry Middleware：高危命令拦截 → 飞书审批（Promise 挂起 / `resolve` 唤醒） |
| 入站 | 意图闸门：L1 硬规则（群聊须 `@`、斜杠命令、短确认）+ L2 轻量分类（ops / chitchat / ack） |
| 并发 | 按 `chatId` 隔离 Session 与 Reporter；同一会话忙碌时不再开第二条引擎 |
| 可观测 | CostTracker 账单、`.claw/traces` 调用树 |

飞书侧：大脑在 `async` 调用栈里跑，事件回调在另一条路径；审批用 `Map<taskID, resolve>` 对齐 Go 的 channel。时序图见 [docs/security-and-communication.md](docs/security-and-communication.md)。

## 快速开始

```bash
npm install
cp .env.example .env   # 填 LLM_API_KEY、LLM_BASE_URL
```

`.env` 示例与厂商端点见仓库根目录 [.env.example](.env.example)。`LLM_BASE_URL` 需含版本前缀（如智谱 `.../v4/`），SDK 会再拼 chat completions。

### 1. AgentOps 飞书长连接（完整拼装）

工作区 `workspace-v2/`（含演示用 `nginx.conf` 与排障 Skill）。开放平台事件订阅选 **使用长连接接收事件**。

```bash
npx tsx cmd/agentops/main.ts
```

另需 `FEISHU_APP_ID`、`FEISHU_APP_SECRET`。群里 `@` 机器人说 Nginx 起不来，会走工具 + 高危审批；闲聊（天气、星期几、心情）走 L2 分类，回一句默认话术，不进 Main Loop。

审批口令：`approve <taskID>` / `reject <taskID>`。

### 2. 生产力 CLI

```bash
npx tsx cmd/claw/index.ts -prompt "你的任务描述" [-dir .] [-session cli_default_session]
```

Plan 模式 + CostTracker + 彩色终端 Reporter；CLI 默认 YOLO，不挂飞书审批。

### 3. 讲义演示入口

```bash
npx tsx cmd/claw/main.ts              # 默认 Tracing
npx tsx cmd/claw/main.ts session      # 并发 Session + Working Memory
npx tsx cmd/claw/main.ts repl         # 终端多轮
npx tsx cmd/claw/main.ts webhook      # 飞书 HTTP，需公网 URL
npx tsx cmd/claw/main.ts ws           # 飞书长连接
npx tsx cmd/bench/main.ts             # 微型 Benchmark
```

模式、别名与 Session 并发演示见 [cmd/claw/README.md](cmd/claw/README.md)。

### 4. 意图过滤器单测（不打真实 LLM）

```bash
npx tsx internal/feishu/intent-filter.test.ts
```

## 项目结构

```
ts-tiny-claw/
├── cmd/
│   ├── agentops/main.ts     # AgentOps：飞书长连接 + 审批 + 意图闸门
│   ├── claw/
│   │   ├── index.ts         # 生产力 CLI
│   │   └── main.ts          # 讲义多模式演示（trace / repl / webhook / ws / …）
│   └── bench/main.ts        # Benchmark 入口
├── internal/
│   ├── engine/              # Main Loop、Session、Reporter、Reminder
│   ├── feishu/              # Bot、审批、意图 L1/L2
│   ├── tools/               # Registry、Middleware、四件套工具、Subagent
│   ├── provider/            # OpenAI 兼容 / Claude
│   ├── context/             # PromptComposer、Skills、Recovery
│   ├── observability/       # CostTracker、Tracing
│   ├── schema/              # Message / ToolCall
│   ├── eval/                # Benchmark runner
│   └── log/                 # 启动与运行日志
├── workspace-v2/            # AgentOps 工作区（nginx 排障剧本）
├── docs/                    # 时序图、意图过滤计划
├── .env.example
└── README.md
```

## 环境变量

| 变量 | 用途 |
|------|------|
| `LLM_API_KEY` / `LLM_BASE_URL` | 必填 |
| `LLM_MODEL` | 默认 `glm-4.5-air` |
| `LLM_INTENT_MODEL` | 意图分类模型，默认与 `LLM_MODEL` 相同 |
| `FEISHU_APP_ID` / `FEISHU_APP_SECRET` | 飞书应用（AgentOps / webhook / ws） |
| `FEISHU_BOT_OPEN_ID` / `FEISHU_BOT_NAME` | 群聊准确识别 `@` 本机器人 |
| `FEISHU_INTENT_LLM` | 意图 L2，默认开；`0` 关闭 |
| `FEISHU_ENCRYPT_KEY` / `FEISHU_VERIFY_TOKEN` | HTTP 事件加密与校验（可选） |
| `PORT` | Webhook 端口，默认 `48080` |
| `CLAW_MODE` | `cmd/claw/main.ts` 启动模式 |
| `CLAW_VERBOSE` | `1` 时打印引擎 Turn/Phase 内部日志 |

## 和 Go 的对应

| Go | Node |
|---|---|
| Goroutine + `chan` 审批挂起 | `async` + `Promise` resolver |
| `context.WithValue(reporterKey)` | `TraceContext.reporter`，`startSpan` 级联拷贝 |
| `go handleAgentRun` | `void handleAgentRun`（不阻塞飞书回调） |
| `cmd/agentops/main.go` | `npx tsx cmd/agentops/main.ts` |

## License

ISC
