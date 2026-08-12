# cmd/claw — 进程入口

对应 Go `cmd/claw/main.go`。Node 版在飞书 HTTP Webhook 之外，额外提供 **CLI** 与 **飞书长连接** 两种入口。

在项目根目录执行（会自动加载根目录 `.env`）：

```bash
npx tsx cmd/claw/main.ts [模式] [可选参数…]
```

也可用环境变量选模式（优先级高于默认，可被命令行参数覆盖逻辑见下）：

```bash
CLAW_MODE=cli|webhook|ws npx tsx cmd/claw/main.ts
```

---

## 模式一览

| 模式 | 命令 | 要不要飞书 | 说明 |
|------|------|------------|------|
| **cli**（默认） | `npx tsx cmd/claw/main.ts` | 否 | 终端 REPL，不依赖事件订阅 |
| **cli** 一次性 | `npx tsx cmd/claw/main.ts cli "任务…"` | 否 | 跑完一轮就退出 |
| **webhook** | `npx tsx cmd/claw/main.ts webhook` | 要（HTTP 推事件） | 对齐 Go：监听 `/webhook/event` |
| **ws** | `npx tsx cmd/claw/main.ts ws` | 要（长连接） | 不用公网 Webhook URL |

别名（等价）：

- `webhook` ← `feishu` / `http`
- `ws` ← `websocket` / `long-connection`
- `cli` ← `repl` / `chat`

---

## 1. CLI（本地对话，推荐先跑通）

不经过飞书 EventListener / Webhook / 长连接。进度与最终回答由终端 `Reporter` 打印（默认安静；引擎 Turn/Phase 细节需开 verbose）。

```bash
# 交互式：多轮输入，空行或 exit / quit 退出
npx tsx cmd/claw/main.ts
npx tsx cmd/claw/main.ts cli

# 一次性任务
npx tsx cmd/claw/main.ts cli "读取 a.txt、b.txt、c.txt 并总结"
npx tsx cmd/claw/main.ts "帮我查下本机 IP"   # 首参不是模式名时，整段当作一次性 prompt

# 查看引擎内部轨迹（Turn / Phase / 思考全文等）
CLAW_VERBOSE=1 npx tsx cmd/claw/main.ts
```

**依赖环境变量：** `LLM_API_KEY`、`LLM_BASE_URL`（可选 `LLM_MODEL`，默认 `glm-4.5-air`）。

---

## 2. 飞书 HTTP Webhook（对应 Go 主入口）

```bash
npx tsx cmd/claw/main.ts webhook
# 或
CLAW_MODE=webhook npx tsx cmd/claw/main.ts
```

- 默认监听 `:48080`（可用 `PORT` 覆盖）
- 回调路径：`http://<host>:<port>/webhook/event`
- 开放平台「事件配置」选 **将事件发送至开发者服务器**，请求地址填**公网** URL
- 保存时飞书会 POST `url_verification`；本入口已开 `autoChallenge: true`

**注意：** `http://172.x.x.x:48080/...` 这类内网地址，飞书云通常访问不到，URL 校验会失败。本地无公网时请改用下方 **ws**。

**额外环境变量：** `FEISHU_APP_ID`、`FEISHU_APP_SECRET`；若开了加密/校验则还需 `FEISHU_ENCRYPT_KEY`、`FEISHU_VERIFY_TOKEN`（或 `FEISHU_VERIFICATION_TOKEN`）。

---

## 3. 飞书长连接（不用 HTTP EventListener）

```bash
npx tsx cmd/claw/main.ts ws
# 或
CLAW_MODE=ws npx tsx cmd/claw/main.ts
```

- 开放平台「事件配置」选 **使用长连接接收事件**（不要填 HTTP 请求地址）
- 进程主动连飞书，本地只要能访问公网即可收 `im.message.receive_v1`
- 回帖仍走应用身份 OpenAPI（`FeishuReporter`）

**额外环境变量：** 同 webhook（`FEISHU_APP_ID` / `FEISHU_APP_SECRET` 等）。

---

## 环境变量速查

| 变量 | 用途 |
|------|------|
| `LLM_API_KEY` | LLM 密钥（必填） |
| `LLM_BASE_URL` | OpenAI 兼容 API 根（必填，含版本前缀如 `/v1`） |
| `LLM_MODEL` | 模型名，默认 `glm-4.5-air` |
| `CLAW_MODE` | `cli` / `webhook` / `ws` |
| `CLAW_VERBOSE` | `1` / `true` 时打印引擎内部轨迹 |
| `PORT` | Webhook 监听端口，默认 `48080` |
| `FEISHU_APP_ID` / `FEISHU_APP_SECRET` | 飞书应用（webhook / ws 必填） |
| `FEISHU_ENCRYPT_KEY` | 事件加密（开放平台若启用则必填且一致） |
| `FEISHU_VERIFY_TOKEN` | Verification Token（可选，亦可用 `FEISHU_VERIFICATION_TOKEN`） |

示例见仓库根目录 [`.env.example`](../../.env.example)。

---

## 和 Go 的对应关系

| Go | Node |
|----|------|
| 仅 `http.ListenAndServe` + `/webhook/event` | `npx tsx cmd/claw/main.ts webhook` |
| （无） | `cli`：终端对话 |
| （无，或另写长连接） | `ws`：`FeishuBot.startLongConnection()` |
