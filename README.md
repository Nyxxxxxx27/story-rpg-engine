# Story RPG Engine

一个面向长线剧情的本地 RPG 工作台。玩家可以从网页或 Codex MCP 发送行动；Director、连续性、阶段、主角自主性、动态角色和故事包 Agent 按行动风险执行合并或完整审查，只提交结构化候选变化。事实事务提交后，Narrator 才生成正文，Polish Agent 在正式显示前只润色文笔。

本项目完全重构自对 XianTu 产品思路的研究。原项目仅作为 RPG 交互参考；这里没有继承旧架构、LangGraph NPC 图、人工 Bridge 或修仙专用内核。

## 核心能力

- 通用 `story-v2` 内核：世界、阶段、角色、关系、事实、场景、回合、Prompt 版本和托管。
- 开局向导：随机大纲先审核，可编辑或重新生成，确认后才创建正式世界。
- 长期主线、人物关系与历史证据进入规划和审查。每阶段以有事实证据的里程碑计算进度；结算后由玩家确认下一阶段，最终阶段结算后结束故事。
- 普通场景提供行动按钮；关键选择使用持久化 decisionId，在同一事务中确认选择并创建唯一后续回合。选择后只推进一场，原托管保持暂停。
- 阶段截止时间使用绝对故事分钟；到期未完成会暂停，由玩家延期或按实际进度结束，支持部分完成、放弃及有证据的失败。
- 主角与核心人物常驻摘要；当场核心人物按数据库实时创建独立 Character Agent。
- 固定回合：`queued → assembling → directing → reviewing → repairing? → committing → narrating → polishing? → verifying? → narration_repair? → summarizing → completed/waiting_player`。
- 正式输出前润色默认开启。普通正文、润色和摘要做规则检查；重大选择后果、不可逆变化、阶段结算或疑似冲突触发语义检查。只允许一次正文修订，仍失败则显示已提交公开事件的保守简述；支持仅重写正文。
- 校验前的正文不经 SSE 发布。规则检查覆盖部分冲突模式，不等于证明任意自然语言的语义完全一致。
- 单次修订上限；第二次规则失败不会写世界状态。
- 规范事实携带结构化事件 payload 与来源 ID，可独立重放并校验状态哈希。
- 网页、SSE 和项目级 MCP 共用 `/api/v2` 回合协议。
- 托管使用故事内时间：6 小时、1 天、3 天、7 天或 1 小时至 30 天，最多 50 场；重大变化自动暂停。
- `cultivation-hewan`、`western-fantasy` 与通用故事包可独立启用，内核不硬编码题材术语。

## 五批扩展（存档版本 7）

已增加相关历史检索与后台索引、完整历史阅读、恋爱配置、低风险合并审查、逐项正文依据、导出恢复、结果驱动路线与历史分叉、通用资源及四类规则、NPC 知识与预警调度。

使用方式及边界见 [五批交付说明](docs/FIVE_BATCH_EXPERIENCE.md)，实测记录见 [五批验收](reports/acceptance/FIVE_BATCH_ACCEPTANCE.md)。

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
- `story_resolve_choice`
- `story_resume_autoplay`
- `story_resolve_deadline`
- `story_retry_narration`
- `story_retry_turn`

网页手动输入与 MCP 输入按服务器接收顺序进入同一队列；手动输入暂停托管。

## API 概览

所有接口位于 `/api/v2`：

- `POST /stories`、`PUT /stories/:id/config`
- `POST /stories/:id/outline/generate`
- `PUT /stories/:id/outline`、`POST /stories/:id/outline/confirm`
- `POST /stories/:id/turns`、`GET /stories/:id/turns/:turnId`
- `POST /stories/:id/choices/resolve`（decisionId、optionId 或 choice、idempotencyKey；返回 continuationTurnId）
- `POST /stories/:id/turns/:turnId/retry`
- `POST /stories/:id/scenes/:sceneId/narration/retry`
- `POST /stories/:id/stages/:stageId/deadline/resolve`（revision、action、deadlineMinutes、idempotencyKey）
- `GET /stories/:id/metrics`（步骤耗时、语义检查和降级比例）
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
npm run test:v2-smoke
```

`npm test` 覆盖事务幂等、上下文补取、正文反例与修订、里程碑证据、40 回合历史保留、迁移及恢复。浏览器测试使用独立存档、4273 端口及动态 API 端口；可先执行 `npx playwright install chromium`，也可在已有 Chrome 的 Windows 上使用 `$env:PLAYWRIGHT_CHANNEL='chrome'`。

`test:v2-smoke` 使用新建隔离存档和真实 Codex 回合 Agent（大纲采用确定性夹具），验证选择后果、正文检查及仅重写正文。保存 `reports/v2-smoke.json` 和对应存档，便于复查。

可选的 `npm run test:three-day` 运行更长的真实模型验收：网页确认、MCP 行动、明确处理阶段/选择暂停、手动恢复托管和中途重启；达到 4320 故事分钟或最终结局时停止。它使用全新 `.data/acceptance-three-day-*` 存档，耗时明显长于冒烟测试。

## 存档升级

启动时幂等迁移到结构版本 2。修改旧投影前，将原始记录写入数据目录下的 `migration-backups/<storyId>-v1.json`，同时保存在 `story_save_backups` 表。文件写入失败会回滚该存档迁移。

保留旧正文、事实和已完成阶段的历史结论。旧未完成阶段生成待核验里程碑，旧百分比保存在 `legacyProgress`，不据此虚构完成证据。旧等待选择补建 decision；已经确认的旧选择不补跑后果。迁移与阶段变化追加可重放事件。

接口细节、错误恢复和验收覆盖见 [v2 交付说明](docs/V2_CORE_EXPERIENCE.md)。

## 数据与安全

`.data/`、`.env*`（示例除外）、`node_modules/`、`dist/`、普通日志、Playwright 结果、私钥和临时报告均被忽略。仓库只保留最终验收材料。高级 Prompt 是世界设定的一部分，不能覆盖事实提交、玩家自主性和内容边界等引擎规则。

## 目录

```text
apps/api        Fastify API、SSE 与本地 Worker
apps/mcp        项目级 STDIO MCP
apps/web        React 剧情工作台
packages/contracts       story-v2 Schema
packages/storage         PostgreSQL、事件与投影
packages/agent-runtime   Provider、Prompt 与固定流水线
packages/content         版本化故事包
tests            核心、恢复与浏览器测试
scripts          构建、开发与三天验收驱动器
```

## License

MIT
