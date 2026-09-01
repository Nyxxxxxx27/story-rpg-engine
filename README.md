# Story RPG Engine

一个面向长线剧情的本地 RPG 工作台。玩家可以从网页或 Codex MCP 发送行动；Director、连续性、阶段、主角自主性、动态角色和故事包 Agent 会经过固定流水线，只提交结构化候选变化。事实事务提交后，Narrator 才生成正文。

本项目完全重构自对 XianTu 产品思路的研究。原项目仅作为 RPG 交互参考；这里没有继承旧架构、LangGraph NPC 图、人工 Bridge 或修仙专用内核。

## 核心能力

- 通用 `story-v1` 内核：世界、阶段、角色、关系、事实、场景、回合、Prompt 版本和托管。
- 开局向导：随机大纲先审核，可编辑或重新生成，确认后才创建正式世界。
- 长期主线与 4–6 个阶段目标；阶段结算后由 Agent 提案，玩家确认下一阶段。
- 主角与核心人物常驻摘要；当场核心人物按数据库实时创建独立 Character Agent。
- 固定回合：`queued → assembling → directing → reviewing → repairing? → committing → narrating → summarizing → completed/waiting_player`。
- 单次修订上限；第二次规则失败不会写世界状态。
- 规范事实携带结构化事件 payload 与来源 ID，可独立重放并校验状态哈希。
- 网页、SSE 和项目级 MCP 共用 `/api/v2` 回合协议。
- 托管使用故事内时间：6 小时、1 天、3 天、7 天或 1 小时至 30 天，最多 50 场；重大变化自动暂停。
- `cultivation-hewan`、`western-fantasy` 与通用故事包可独立启用，内核不硬编码题材术语。

## 技术栈

- React 19 + Vite
- Fastify 5
- PostgreSQL；本地默认使用 PGlite 的 PostgreSQL socket，外部环境可设置 `DATABASE_URL`
- pg-boss 持久队列与 outbox
- OpenAI Agents SDK TypeScript
- Codex App Server 自定义 `ModelProvider`
- MCP TypeScript SDK
- Zod 结构化 Schema

## Provider

默认 Provider 是本机已登录账户的 Codex App Server。进程内只初始化一条持久 App Server 连接，并在该连接上多路复用 Agent 事件；每次模型调用使用独立的：

- `ephemeral` thread
- `read-only` sandbox
- `approvalPolicy = never`
- 无 Agent 工具
- JSON Schema 结构化输出
- 本地 tracing 关闭
- HTTPS-only 自定义 Codex Provider，避免 WebSocket 不可用时的长时间重试

默认模型是 `gpt-5.6-luna`、`low` effort，可用 `CODEX_MODEL` 修改。OpenAI API Provider 只有在故事显式选择 `openai` 且设置 `OPENAI_API_KEY` 时才启用，不会自动切换或隐式产生费用。`deterministic` 只用于自动化协议测试。

## 快速开始

要求 Node.js 24+，并确保 `codex` 已登录。

```powershell
npm install
npm run dev
```

打开 `http://127.0.0.1:4173`。API 默认监听 `http://127.0.0.1:4310`。

生产构建：

```powershell
npm run build
npm start
```

如果使用外部 PostgreSQL，复制 `.env.example`，设置 `DATABASE_URL`。默认数据写入 `.data/story-postgres`，该目录不会进入 Git。

## Codex MCP

项目的 [`.codex/config.toml`](.codex/config.toml) 通过本地 STDIO 注册 `story_rpg` MCP。API 运行时可使用：

- `story_create`
- `story_generate_outline`
- `story_confirm_outline`
- `story_send`
- `story_wait`
- `story_get_state`
- `story_set_stage`
- `story_review_stage_proposal`
- `story_start_autoplay`
- `story_stop_autoplay`

网页手动输入与 MCP 输入按服务器接收顺序进入同一队列；手动输入暂停托管。

## API 概览

所有接口位于 `/api/v2`：

- `POST /stories`、`PUT /stories/:id/config`
- `POST /stories/:id/outline/generate`
- `PUT /stories/:id/outline`、`POST /stories/:id/outline/confirm`
- `POST /stories/:id/turns`、`GET /stories/:id/turns/:turnId`
- `PUT /stories/:id/stages/:stageId`
- `GET /stories/:id/stage-proposal`
- `POST /stories/:id/stage-proposal/:proposalId/review`
- `POST|GET|DELETE /stories/:id/autoplay`
- `POST /stories/:id/autoplay/resume`
- `GET /stories/:id/events`（SSE）

这是本地单用户应用，默认只绑定 `127.0.0.1`。若要暴露到网络，应在前方增加认证、TLS 与访问控制。

## 验证

```powershell
npm run typecheck
npm test
npm run test:ui
npm run build
npm run test:three-day
```

`test:three-day` 会删除并重建专用的 `.data/acceptance-three-day`，使用真实 Codex Provider 随机生成大纲，通过网页确认、MCP 开局并精确推进 4320 故事分钟。它在中点重启 API、Worker、数据库 socket 与 Provider，并检查阶段提案、关键暂停、核心角色参与、事实来源、跨题材泄漏、重复事件和重放哈希。通过后生成 `reports/acceptance/` 下的 JSON、Markdown 与截图。

## 数据与安全

`.data/`、`.env*`（示例除外）、`node_modules/`、`dist/`、普通日志、Playwright 结果、私钥和临时报告均被忽略。仓库只保留最终验收材料。高级 Prompt 是世界设定的一部分，不能覆盖事实提交、玩家自主性和内容边界等引擎规则。

## 目录

```text
apps/api        Fastify API、SSE 与本地 Worker
apps/mcp        项目级 STDIO MCP
apps/web        React 剧情工作台
packages/contracts       story-v1 Schema
packages/storage         PostgreSQL、事件与投影
packages/agent-runtime   Provider、Prompt 与固定流水线
packages/content         版本化故事包
tests            核心、恢复与浏览器测试
scripts          构建、开发与三天验收驱动器
```

## License

MIT
