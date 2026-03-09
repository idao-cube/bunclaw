# BunClaw

> 纯 Bun 的本地 Agent 控制面，设计灵感来自 OpenClaw。  
> A pure-Bun local agent control plane inspired by OpenClaw.

[![Bun](https://img.shields.io/badge/runtime-Bun-black)](https://bun.sh)
[![Protocol](https://img.shields.io/badge/protocol-WebSocket-2ea44f)](#架构v1)
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

## 安装方式（开箱即用）

### 1) npm 安装（推荐）

```bash
npm i -g @idao-cube/bunclaw
```

安装后可直接使用：

```bash
bunclaw --help
bunclaw onboard
bunclaw gateway
```

> 说明：包地址在 npm 组织 `idao-cube` 下。  
> `https://www.npmjs.com/org/idao-cube`

### 2) 二进制安装（无需 npm）

从 GitHub Releases 下载对应平台二进制后执行：

```bash
# Windows
./bunclaw-bun-windows-x64.exe gateway

# Linux
chmod +x ./bunclaw-bun-linux-x64
./bunclaw-bun-linux-x64 gateway

# macOS
chmod +x ./bunclaw-bun-darwin-arm64
./bunclaw-bun-darwin-arm64 gateway
```

### 2.1) Linux/macOS 一键安装（GitHub Releases）

发布后可直接执行安装脚本（自动识别平台与架构）：

```bash
curl -fsSL https://github.com/idao-cube/bunclaw/releases/latest/download/install-unix.sh | sh
```

指定版本示例：

```bash
curl -fsSL https://github.com/idao-cube/bunclaw/releases/latest/download/install-unix.sh | sh -s -- v0.2.5
```

说明：

- 优先安装到 `/usr/local/bin`（可写时）
- 无权限时自动回退到 `~/.local/bin`
- 回退场景会自动写入 shell rc（如 `~/.bashrc` / `~/.zshrc`）以补全 `PATH`

### 3) MSI 安装（Windows）

从 Releases 下载 `BunClaw-<version>-x64.msi`，双击安装后使用：

```powershell
bunclaw --help
```

## OpenClaw 对比

| 项目 | OpenClaw | BunClaw |
| --- | --- | --- |
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

- 通过 npm 安装：无需额外准备 Bun
- 从源码运行：Bun >= 1.3.x

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
    "webSearch": {
      "provider": "",
      "providers": ["news", "media", "bing", "google", "duckduckgo", "baidu", "sogou", "so", "github"],
      "categories": ["tech", "research", "media"],
      "endpoint": "",
      "apiKey": "",
      "timeoutMs": 8000,
      "customScript": ""
    }
  },
  "sessions": {
    "dbPath": "~/.bunclaw/bunclaw.db",
    "eventsPath": "~/.bunclaw/events.jsonl",
    "workspace": "~/.bunclaw/workspace"
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

## TypeScript 类型（零三方依赖）

项目默认不依赖 `@types/bun` / `@types/node`。类型支持由仓库内置声明文件提供：

- `src/bun-ambient.d.ts`：`Bun`、`process`、`bun:test`、`bun:sqlite` 等最小类型声明
- `tsconfig.json`：`types` 为空数组，避免外部类型包耦合

这保证了“纯 Bun + 零第三方类型依赖”的开发体验。

### 自定义搜索脚本（Bun）

`web_search` 支持 `custom` provider，可通过 Bun 脚本接入自定义搜索逻辑：

1. 配置 `tools.webSearch.customScript`，例如：`scripts/custom-web-search.ts`
  或配置 `tools.webSearch.endpoint`（HTTP JSON 接口）。
2. 调用时传入 `providers: ["custom"]` 或 `providers: ["custom", "github", "bing"]`
3. 脚本通过 `stdin` 接收 JSON：`{ query, count, timeoutMs }`
4. 脚本通过 `stdout` 返回 JSON：

```json
{
  "results": [
    { "title": "...", "url": "https://...", "snippet": "...", "source": "..." }
  ]
}
```

项目内提供示例：`scripts/custom-web-search.ts`

`custom` provider 优先级：`endpoint` > `customScript`。任一失败时，会继续执行后续内置 provider（如 `github`/`bing`）。

### 搜索聚合与专业性策略

- 多引擎并行聚合：`news/media/bing/google/duckduckgo/baidu/sogou/so/github`
- 任一引擎不可用自动跳过，不影响其余引擎结果
- 站点分类支持（每类 15+）：`government` / `education` / `research` / `media` / `forum` / `social` / `tech`
- 基于查询意图自动重排引擎优先级：
  - `源码 / code / github`：优先 `github`
  - `官网 / official`：优先通用网页引擎并附带 `site:` 提示
  - `最新 / 今日 / release`：优先 `news/media`
- 结果输出包含检索时间戳与意图标签，降低时效误判风险

`web_search` 常用参数：

- `providers`: 指定引擎集合
- `strictProviders`: `true` 时严格按 `providers` 执行；`false` 时允许按意图自动重排
- `sites`: 专业站点定向域名数组，例如 `["github.com", "openclaw.ai"]`
- `categories`: 站点分类数组，例如 `["tech", "research", "media"]`

如果不在每次调用里传 `categories`，系统会默认使用配置中的 `tools.webSearch.categories`。

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

# 生成 npm 安装包（tgz）
bun run pack:npm

# 生成 MSI（需 Windows + WiX 3）
bun run package:msi
```

### github 构建

```bash
git tag v0.1.0

git push origin v0.1.0
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
- Ubuntu 执行 `package:all` + `pack:npm`
- Ubuntu 额外产出 Unix 安装资产（`install-unix.sh` + `bunclaw-*.tar.gz`）
- Windows 执行 `package:msi`
- 仅在推送 `v*` 标签（或手动触发）时执行
- 推送 `v*` 标签后自动发布到 GitHub Releases（包含二进制、`.tgz`、`.msi`）

## npm / MSI 发布说明

### npm

```bash
# 先检查 tgz
bun run pack:npm

# 正式发布
bun run publish:npm
```

组织发布目标：

- npm scope：`@idao-cube`
- 包名：`@idao-cube/bunclaw`
- 地址：`https://www.npmjs.com/org/idao-cube`

GitHub Action 自动发布 npm 的前置条件：

- 在仓库 Secrets 配置 `NPM_TOKEN`
- `NPM_TOKEN` 对 `@idao-cube` 组织具备发布权限
- 推送版本标签（如 `v0.1.1`）后触发自动发布

### MSI

- 依赖：WiX Toolset 3（`candle.exe` / `light.exe`）
- 本地构建：

```bash
bun run package:msi
```

## GitHub 开源发布流程（建议）

### 1) 准备仓库信息

- `package.json` 包名使用组织作用域：`@idao-cube/bunclaw`
- 仓库建议：`https://github.com/idao-cube/bunclaw`

### 2) 配置 Secrets

- `NPM_TOKEN`：npm 发布 token（对 `@idao-cube` 有 publish 权限）

### 3) 发布版本

```bash
git tag v0.1.1
git push origin v0.1.1
```

触发后 workflow 会自动：

- 三平台跑测试
- 构建多平台二进制
- 构建 npm tarball
- 构建 Windows MSI
- 发布到 GitHub Releases
- 发布到 npm（`@idao-cube/bunclaw`）

## 常见问题（安装/发布）

- `ENEEDAUTH`：通常是 `NPM_TOKEN` 缺失或权限不足（组织权限不够）。
- `No files were found with dist/*.msi`：MSI 构建失败，查看 `Build MSI` 步骤日志。
- Linux/macOS 二进制不可执行：先 `chmod +x`。
- 双击二进制没启动网关：需要带子命令（如 `gateway`）。
- `未知命令: getaway`：命令拼写错误，正确是 `bun start gateway`。
- `EADDRINUSE (port 16789 in use)`：端口已占用。可先停止旧进程，或改配置里的 `gateway.port` 后重启。

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
