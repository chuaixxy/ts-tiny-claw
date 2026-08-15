# 安全与通信：Human-in-the-Loop 时序图

专栏原图（Go）与 Node 对照。对外 15 步交互相同；内部挂起原语从 **Goroutine + channel** 换成 **async + Promise**。

在支持 Mermaid 的预览里打开本文件即可渲染；源图也可单独用 `.mmd` 导入 [mermaid.live](https://mermaid.live)。

---

## 1. Go（go-tiny-claw）

对应原图：引擎主 Goroutine 在 `<-ch` 上挂起，Webhook 协程写入 Approval Channel 后唤醒。

```mermaid
sequenceDiagram
    autonumber
    actor Human as 飞书运维群（人类）
    participant Feishu as 飞书开放平台 Webhook
    participant Agent as AgentOps 服务端<br/>go-tiny-claw
    participant MW as Registry Middleware<br/>安全防线
    participant LLM as Claude / Zhipu API

    Human->>Feishu: @Agent 帮我查一下 nginx 为什么报错？
    Feishu->>Agent: POST /webhook/event
    Agent->>LLM: 组装 Prompt，发起推理（慢思考）
    LLM-->>Agent: ToolCall: bash "cat /var/log/nginx/error.log"
    Agent-->>LLM: 纯读操作，YOLO 放行，返回日志结果

    LLM-->>Agent: ToolCall: bash "nginx -s reload"（高危!）
    Agent->>MW: 准备执行 bash 命令
    Note over MW: 命中危险命令黑名单，触发拦截！

    rect rgb(255, 230, 240)
        MW->>Feishu: Reporter 发送高危操作审批消息
        Feishu->>Human: 展示命令 + [Approve]
        Note over Agent: 引擎主 Goroutine 被挂起，<br/>等待 channel 解锁...
        Human->>Feishu: 检查命令，回复 approve taskID
        Feishu->>Agent: Webhook 收到授权，写入 Approval Channel
    end

    Agent->>MW: 获得人类许可，放行执行
    Agent-->>LLM: ToolResult: 重启成功
    Agent->>Feishu: OnMessage: 报告，服务已安全重启。
    Feishu->>Human: 报告，服务已安全重启。
```

---

## 2. Node（ts-tiny-claw）

业务箭头不变。Webhook 回调里 `void handleAgentRun()` 立刻 200；引擎在 `await waitPromise` 处把控制权交还事件循环；审批回调 `waiter.resolve()` 唤醒同一条 async 调用栈。

```mermaid
sequenceDiagram
    autonumber
    actor Human as 飞书运维群（人类）
    participant Feishu as 飞书开放平台 Webhook
    participant Agent as AgentOps 服务端<br/>ts-tiny-claw
    participant MW as Registry Middleware<br/>安全防线
    participant LLM as Claude / Zhipu API

    Human->>Feishu: @Agent 帮我查一下 nginx 为什么报错？
    Feishu->>Agent: POST /webhook/event<br/>void handleAgentRun()，立刻 200
    Agent->>LLM: 组装 Prompt，发起推理（慢思考）
    LLM-->>Agent: ToolCall: bash "cat /var/log/nginx/error.log"
    Agent-->>LLM: 纯读操作，YOLO 放行，返回日志结果

    LLM-->>Agent: ToolCall: bash "nginx -s reload"（高危!）
    Agent->>MW: 准备执行 bash 命令
    Note over MW: 命中危险命令黑名单，触发拦截！

    rect rgb(255, 230, 240)
        MW->>Feishu: Reporter 发送高危操作审批消息
        Feishu->>Human: 展示命令 + [Approve]
        Note over Agent: 引擎在 await waitPromise 处挂起<br/>事件循环继续处理下一枪 Webhook
        Human->>Feishu: 检查命令，回复 approve taskID
        Feishu->>Agent: Webhook 回调 waiter.resolve(allowed)
    end

    Agent->>MW: 获得人类许可，放行执行
    Agent-->>LLM: ToolResult: 重启成功
    Agent->>Feishu: OnMessage: 报告，服务已安全重启。
    Feishu->>Human: 报告，服务已安全重启。
```

---

## 对照要点

| 时序位置 | Go | Node |
|---|---|---|
| 第 2 步：收消息 | `go handleAgentRun(...)` | `void this.handleAgentRun(...)` |
| 粉色框内：挂起 | `result := <-ch` | `await waitPromise` |
| 第 12 步：唤醒 | `ch <- ApprovalResult{...}` | `waiter.resolve({ allowed, reason })` |
| 实现位置 | Goroutine + `chan` | `internal/feishu/approval.ts` 的 `Map<taskID, resolve>` |
