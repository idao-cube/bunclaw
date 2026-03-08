# BunClaw

> 纯 Bun 的本地 Agent 控制面，设计灵感来自 OpenClaw。  
> A pure-Bun local agent control plane inspired by OpenClaw.

[![Bun](https://img.shields.io/badge/runtime-Bun-black)](https://bun.sh)
[![Protocol](https://img.shields.io/badge/protocol-WebSocket-2ea44f)](#协议)
[![License](https://img.shields.io/badge/license-MIT-blue)](#license)

## 为什么是 BunClaw

BunClaw 是一个面向本地开发与自动化的 Agent 内核，目标是：

- 保留 OpenClaw 的核心思想（Gateway 控制面、会话一等对象、工具调用循环、流式事件）
- 收敛实现范围，先把单机可用性做扎实
- 全面去掉 Node 依赖链，仅使用 Bun 内建能力

适合人群：

- 需要一个可控、可二开、可本地部署的 AI 助手内核
- 希望通过 WebSocket 协议接入自定义前端/终端客户端
- 想要“先本地跑通、再逐步扩展渠道/插件/设备能力”

## OpenClaw 对比

| 项目 | OpenClaw | BunClaw |
|---|---|---|
| 技术栈 | Node/TS 生态 | **纯 Bun** |
| 控制面 | Gateway + 多模块 | **Gateway + Agent + CLI（v1）** |
| 渠道接入 | 丰富（IM/设备等） | 本地 Web UI + CLI |
| 目标 | 全栈 Agent 平台 | 轻量、可维护、可扩展内核 |
| 默认部署 | 可远程与组网 | 本地单用户优先 |

## 核心特性

- 纯 Bun：`Bun.serve` / `WebSocket` / `bun:sqlite` / `Bun.spawn` / `fetch`
- 控制面协议：`connect` + `req/res/event` 三类帧
- 幂等保障：`agent.run`、`message.send` 支持 `idemKey`
- 会话模型：SQLite 持久化 + JSONL 事件流
- 工具策略：`profile + allow + deny`（deny 优先）
- Agent 循环：OpenAI-compatible + tool call 回填迭代
- 内置 UI：聊天、日志、系统配置、统计（PC/H5 自适应）
- 打包发布：单文件二进制 + GitHub Actions 多平台构建

## 架构（v1）

```text
CLI / Web UI
     |
 WebSocket (connect, req/res/event)
     |
   Gateway  -------------------> Event JSONL
     | \
     |  \--> Process Manager
     |
   Agent Runtime ---> OpenAI-compatible API
     |
   Tool Registry + Policy
     |
   SQLite (sessions/messages/idempotency)
```

## 快速开始

### 1) 运行环境

- Bun >= 1.3.x

### 2) 初始化

```bash
bun run bin/bunclaw.ts onboard
```

默认资源目录位于用户主目录：

- `~/.bunclaw/bunclaw.json`
- `~/.bunclaw/bunclaw.db`
- `~/.bunclaw/events.jsonl`
- `~/.bunclaw/skills`
- `~/.bunclaw/agents`
- `~/.bunclaw/channels`

### 3) 启动网关

```bash
bun run bin/bunclaw.ts gateway
```

默认入口：

- `ws://127.0.0.1:16789/ws`
- `http://127.0.0.1:16789/`

### 4) CLI 调用

```bash
# 发送消息
bun run bin/bunclaw.ts message send --session main --message "你好"

# 运行一次 Agent
bun run bin/bunclaw.ts agent --session main --message "总结当前仓库"

# 健康检查
bun run bin/bunclaw.ts doctor
```

## Web UI

- `/chat`：IM 风格会话、流式输出、消息 token 显示、清空聊天
- `/logs`：系统/事件日志（不展示聊天正文）
- `/config`：表单配置 + 原始 JSON 配置切换编辑
- `/stats`：会话/消息/token/事件 + 系统信息面板

## 配置说明

配置文件：`~/.bunclaw/bunclaw.json`

```json
{
  "gateway": {
    "host": "127.0.0.1",
    "port": 16789,
    "token": "",
    "allowExternal": false
  },
  "model": {
    "baseUrl": "https://api.openai.com/v1",
    "apiKey": "",
    "model": "gpt-4.1-mini",
    "maxToolRounds": 4
  },
  "tools": {
    "profile": "coding",
    "allow": [],
    "deny": [],
    "webSearch": { "provider": "", "endpoint": "", "apiKey": "" }
  },
  "sessions": {
    "dbPath": "~/.bunclaw/bunclaw.db",
    "eventsPath": "~/.bunclaw/events.jsonl",
    "workspace": "."
  },
  "storage": {
    "baseDir": "~/.bunclaw",
    "skillsDir": "~/.bunclaw/skills",
    "agentsDir": "~/.bunclaw/agents",
    "channelsDir": "~/.bunclaw/channels"
  },
  "security": { "workspaceOnly": true },
  "ui": { "brandName": "BunClaw" }
}
```

## CLI 命令

- `onboard`：初始化配置与目录
- `gateway`：启动网关
- `agent --message "..." [--session main]`
- `message send --message "..." [--session main]`
- `doctor`：配置/网关/模型/SQLite 检查
- `clean`：清空聊天相关数据

## 打包与发布

### 本地打包

```bash
# 当前平台
bun run package

# 多平台
bun run package:all
```

### 产物启动示例

```bash
# Windows
./dist/bunclaw-bun-windows-x64.exe gateway

# Linux
chmod +x ./dist/bunclaw-bun-linux-x64
./dist/bunclaw-bun-linux-x64 gateway

# macOS
chmod +x ./dist/bunclaw-bun-darwin-arm64
./dist/bunclaw-bun-darwin-arm64 gateway
```

> 注意：二进制需要跟随子命令运行（如 `gateway`），仅执行 `--help` 不会启动服务。

### GitHub Actions

工作流：`.github/workflows/build-package.yml`

- 三平台矩阵测试（Windows/macOS/Linux）
- Ubuntu 执行 `package:all` 产出多平台二进制
- 自动上传 `dist/*` 构建产物
- 当推送 `v*` 标签时，自动创建/更新 GitHub Release 并附带 `dist/*` 二进制

## 开发与测试

```bash
bun test
```

当前测试覆盖：

- 协议校验
- 幂等与存储
- 工具策略
- Gateway 集成
- Web UI 页面契约
- 打包命名逻辑
- 纯 Bun 约束（禁止 `node:*`）

## 路线图

- [ ] 插件化工具注册与权限分层
- [ ] 渠道适配（IM/Webhook）
- [ ] 更细粒度的统计与审计回放
- [ ] 多用户/多工作区隔离策略

## 贡献

欢迎 Issue / PR。建议提交前执行：

```bash
bun test
```

## License

MIT

---

## English (Brief)

BunClaw is a pure-Bun local agent core inspired by OpenClaw, focusing on a stable v1 control plane:

- Gateway + WebSocket protocol (`connect`, `req/res/event`)
- Agent runtime with OpenAI-compatible backend and tool loop
- SQLite sessions/messages/idempotency + JSONL events
- Built-in Web UI (`/chat`, `/logs`, `/config`, `/stats`)
- Single-binary packaging and GitHub Actions CI
