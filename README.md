# ts-tiny-claw

go-tiny-claw 的 TypeScript 实现版本。

## 项目结构

```
ts-tiny-claw/
├── cmd/
│   └── claw/
│       └── main.ts          # 程序入口
├── internal/
│   ├── engine/              # MainLoop 核心实现
│   ├── provider/            # 大模型接口抽象与具体厂商 SDK 实现
│   ├── context/             # Token 监控、Prompt 动态组装
│   ├── tools/               # 工具注册表、Middleware、基础工具(bash/edit等)
│   ├── memory/              # 基于文件系统的记忆状态存取
│   └── feishu/              # 飞书机器人交互回调
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
