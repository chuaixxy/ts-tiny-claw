# ts-tiny-claw

go-tiny-claw 的 TypeScript 实现版本。

## 项目结构

```
ts-tiny-claw/
├── cmd/
│   └── claw/
│       └── main.ts          # 测试入口：将挂载 Mock 组件运行 Main Loop
├── internal/
│   ├── engine/              # 【核心引擎层】
│   │   └── loop.ts          # 本讲核心：Main Loop 逻辑
│   ├── provider/            # 【模型适配层】
│   │   └── interface.ts     # LLM Provider 接口定义
│   ├── schema/              # 【公共数据结构】
│   │   └── message.ts       # 统一的消息与工具调用类型定义
│   └── tools/               # 【工具与执行层】
│       └── registry.ts      # 工具注册与分发接口
├── package.json
├── tsconfig.json
└── README.md
```

## 快速开始

```bash
# 安装依赖
npm install

# 直接运行（无需编译）
npx tsx cmd/claw/main.ts

# 编译后运行
npx tsc && node dist/cmd/claw/main.js
```
