# 计划：意图拦截过滤器（Intent Filter）

为 AgentOps 飞书入口增加入站意图闸门：群聊闲聊与私聊短回复都不得唤醒 Main Loop，避免浪费 Token、污染 Session，以及在审批挂起时再开一条引擎。

对应入口：`cmd/agentops/main.ts`（长连接）与 `cmd/claw/main.ts` 的 webhook/ws。过滤器做在 `FeishuBot` Dispatcher，两处入口自动生效。

---

## 1. 目标与非目标

**目标**

- 群聊：默认只有明确叫到机器人（`@` / 斜杠命令）才跑 Main Loop。
- 私聊：没有 `@` 可依赖，用规则 + 可选小模型挡住「好的 / 哈哈 / 收到」和跑题，但仍能直接下任务。
- 过滤发生在 `session.append` 与 `handleAgentRun` **之前**。
- 审批口令、会话忙碌锁的现有行为不变，且优先级高于意图过滤。

**非目标（本计划不做）**

- 不把过滤器放进 `AgentEngine` / Registry Middleware（那是推理与工具安全，太晚）。
- 不单独起一个 HTTP 网关进程。
- 第一期不上独立分类微服务；小模型分类器是同进程、可选的 L2。

---

## 2. 架构决策

主闸门在 **飞书 Dispatcher 接收层**（`internal/feishu/bot.ts` 的 `im.message.receive_v1`）。

| 层 | 职责 | 本功能 |
|---|---|---|
| Dispatcher | 这是不是给 Agent 的请求 | **意图过滤放这里** |
| Engine | 怎么想、调什么工具 | 不改 |
| Middleware | 工具危不危险 | 不改 |

群聊 / 私聊只改变 L1/L2 **权重**，不改变分层：`chat_type` 属于飞书入站协议，与 `approve` 口令、`runningChats` 同类。

```
飞书 im.message.receive_v1
  ├─ 机器人自己 / 空文本 / 非 text          → 丢弃
  ├─ approve / reject（含 TaskID 容错）     → 只写 Approval Channel
  ├─ 本 chatId 正在跑 Main Loop            → 提示等审批，不开新引擎
  ├─ L1 规则（按 group / p2p 分叉）         → wake | drop | unsure
  ├─ L2 小模型（仅 unsure，且开关打开）     → ops | chitchat | ack
  └─ wake 才 void handleAgentRun()
```

---

## 3. 群聊 vs 私聊策略

飞书 `message.chat_type`：`group` | `p2p`（及少数 `topic_group`，按群聊处理）。

| | 群聊 `group` | 私聊 `p2p` |
|---|---|---|
| 默认假设 | 不 @ 就没叫 Bot | 窗口内句子更可能是任务 |
| L1 唤醒 | `@本应用` 或 `/ops` 等斜杠 | 斜杠命令；明显排障关键词；较长、像任务的句子 |
| L1 丢弃 | 未 @ 且无斜杠 | 纯表情、极短寒暄（好的/收到/哈哈/嗯/ok） |
| L1 不确定 | 未 @ 但含故障口吻（可选进 L2） | 中等长度、不像寒暄也不像明确 SOP |
| L2 必要性 | 第一期可关，靠 @ 即可 | 第一期建议开：没有 @，规则召回不够 |

**`@` 判定**：用事件里的 `message.mentions[]` 对 `FEISHU_APP_ID` / open_id，不要只靠文本里的 `@名字`（昵称会变、会被截掉）。

---

## 4. 落地步骤

### 4.1 补齐入站事件形状

文件：`internal/feishu/bot.ts` 的 `FeishuMessageEvent`

补上：

- `message.chat_type?: "p2p" | "group" | "topic_group" | string`
- `message.mentions?: { id?: { open_id?: string; app_id?: string }; key?: string }[]`

缺省：无 `chat_type` 时按 **group 严进**（少唤醒优于群里乱说话）。

### 4.2 抽出 Intent Filter 模块

新建：`internal/feishu/intent-filter.ts`

纯函数，便于单测、不依赖 HTTP/WS：

```ts
type IntentDecision = "wake" | "drop" | "unsure"

function decideIntent(input: {
  chatType: string
  text: string
  mentionedBot: boolean
}): IntentDecision
```

L1 规则草案：

- **共同**：空、贴纸/图片（`message_type !== "text"`）→ `drop`
- **group / topic_group**：`mentionedBot || /^\/(ops|agent)\b/i` → `wake`；否则若像故障句（nginx/报错/502/起不来等）→ `unsure`，否则 `drop`
- **p2p**：斜杠命令 → `wake`；匹配寒暄表（好的、收到、谢谢、哈哈、嗯、ok、👌）且长度很短 → `drop`；含排障关键词或长度超过阈值 → `wake`；其余 → `unsure`

寒暄表与关键词放模块常量，后续可改环境变量，不必先做配置中心。

### 4.3 接入 Dispatcher（关键顺序）

改：`internal/feishu/bot.ts` 事件回调，插在 **忙碌锁之后、`handleAgentRun` 之前**：

1. 现有：忽略 app、抽文本、审批口令、`runningChats`
2. **新增**：`decideIntent(...)`
3. `drop` → `log` 后 `return`（群聊静默；私聊默认也静默，避免「好的」还回一句）
4. `wake` → `void handleAgentRun`
5. `unsure` → 若 `FEISHU_INTENT_LLM=1` 则走 L2，否则：群聊 `drop`、私聊 `wake`（私聊不确定时宁可接住任务）

**禁止**在判定 `wake` 之前 `sess.append`。

### 4.4 L2 小模型分类器（第二期可同 PR 做完，用开关关掉）

新建：`internal/feishu/intent-classifier.ts`

- 复用 `createOpenAIProvider`，模型用 `LLM_INTENT_MODEL`（默认更小/更便宜，例如 `glm-4.5-air` 也可先共用，后续再拆）
- **无工具**、单轮、强制短输出：`ops` | `chitchat` | `ack`
- 超时（如 800ms）或解析失败：回退到 4.3 的 unsure 默认（群 drop / 私 wake）
- 不写 Session、不调 Reporter（除非以后要做 debug 日志）
- Dispatcher 里 `void` 分类后再决定是否 `handleAgentRun`，**不要 await 分类器挡住飞书回调**；用「先 return 事件、后台再决定」时要小心：长连接回调已经很快，可 `void (async () => { ... })()`，与现在 `void handleAgentRun` 同模式

第一期若只想交 L1：分类器文件可以先写接口 + 开关默认关。

### 4.5 装配

`cmd/agentops/main.ts` 无需改拼装顺序；Bot 内部读环境变量即可。

可选环境变量：

| 变量 | 含义 | 默认 |
|---|---|---|
| `FEISHU_INTENT_LLM` | 是否启用 L2 | `0`（先只靠 L1） |
| `LLM_INTENT_MODEL` | 分类模型 | 与 `LLM_MODEL` 相同或更小 |

### 4.6 观测

对每次 drop/wake/unsure 打日志：`chatType`、`decision`、是否 mentioned。便于对照 Token 账单看过滤器是否生效。不把闲聊写入 `.claw/traces`（因为根本不进 Engine）。

---

## 5. 验收

**群聊**

- [ ] 未 @ 的「今天中午吃什么」不打 LLM、不 append Session
- [ ] `@机器人 帮我看 nginx` 唤醒 Main Loop
- [ ] 审批挂起时群里闲聊仍走忙碌锁，不开第二条引擎

**私聊**

- [ ] 「好的」「收到」「哈哈」不唤醒
- [ ] 「线上 nginx 起不来，帮我排查」无 @ 也唤醒
- [ ] 私聊审批挂起时再发「好的」不新开 Loop（忙碌锁优先）

**共同**

- [ ] `approve <taskID>` 仍只解锁 channel
- [ ] 过滤失败不得导致飞书事件超时；L2 失败有确定回退

---

## 6. 建议实施顺序

1. 补事件字段 + L1 `decideIntent` + Dispatcher 接入（即可挡住群闲聊与私聊寒暄）
2. 加日志与人工对照几条真实群/私消息
3. 再开 `FEISHU_INTENT_LLM` 补私聊召回

先做完第 1 步，AgentOps 在群里就不会对每句话烧 Token；私聊至少能挡住最廉价的短回复。
