# RPG 核心体验 v2

四项能力已落到同一套网页、`/api/v2`、MCP 和持久队列协议。存档结构版本为 2。

## 玩家行为

- 普通场景显示建议行动；点击和自由输入都创建一个回合。
- 关键选择有稳定 `decisionId` 和场景内 `optionId`。确认后自动执行一场后果；托管保持暂停，需要点击“继续托管”。自由输入也通过同一确认事务。
- 超时先处理阶段事项：延期到新的故事分钟，或按实际成果结束。延期及确认下一阶段均不会自行恢复托管。
- 全部必需里程碑完成才成功。部分完成、放弃、失败保留不同结论与证据；最后一个阶段结算后故事结束。
- 正文校验失败时最多修订一次；仍失败显示保守简述，保留可用行动，提供“重新生成正文”。这不会重放行动。

## 实现位置

| 批次 | 主要代码 | 验证重点 |
| --- | --- | --- |
| 上下文与证据 | `packages/storage/store.ts`、`packages/agent-runtime/prompts.ts` | 主线、关系、当前时间；24 条近期事实之外按 ID 补取旧证据；版本变化重新规划 |
| 选择自动推进 | `packages/contracts/index.ts`、`packages/storage/store.ts`、API、网页、MCP | 选择事实、后续回合和 outbox 同一事务；并发幂等；明确授权范围 |
| 正文一致性 | `packages/agent-runtime/public-narration.ts`、`runtime.ts` | 规则检查、关键场景语义检查、润色回退、一次修订、保守简述、仅重试正文 |
| 阶段结算 | `packages/storage/stages.ts`、`migrations.ts`、`store.ts` | 里程碑证据、绝对截止时间、延期/结算、最终结束、迁移和事件重放 |

## 接口示例

关键选择：

```http
POST /api/v2/stories/:storyId/choices/resolve
Content-Type: application/json

{
  "decisionId": "<uuid>",
  "optionId": "option_...",
  "idempotencyKey": "choice-request-001"
}
```

返回 `decisionId`、`factId`、来源 `turnId` 和 `continuationTurnId`。使用后者轮询 `/stories/:id/turns/:turnId`，或订阅 SSE。相同选择的重试返回同一后续回合；同键不同内容、失效选项或已改变的选择返回 409。自定义行动使用 `choice` 替换 `optionId`。兼容 `{ "choice": "..." }` 的旧入口，但只在能唯一定位当前选择时执行。

普通选项通过 `POST /stories/:id/turns` 发送 `input`、`sceneId`、`optionId`、`source`、`idempotencyKey`；来源场景必须仍是最新已发布场景。

阶段超时：

```http
POST /api/v2/stories/:storyId/stages/:stageId/deadline/resolve
Content-Type: application/json

{
  "revision": 3,
  "action": "extend",
  "deadlineMinutes": 2160,
  "idempotencyKey": "deadline-request-001"
}
```

`deadlineMinutes` 是从故事开始计算的绝对分钟，必须晚于当前时刻。结束阶段使用 `action: "close"`。旧版本提交返回 `STALE_STAGE`；有超时事项时行动返回 `STAGE_DEADLINE_REQUIRES_REVIEW`。

`POST /stories/:id/scenes/:sceneId/narration/retry` 仅重写正文；`POST /stories/:id/turns/:turnId/retry` 恢复失败回合。两者均携带 `idempotencyKey`，并返回原回合 ID。提交后的恢复只处理叙事步骤，提交前重试复用原回合。

MCP 对应工具：`story_resolve_choice`、`story_resume_autoplay`、`story_resolve_deadline`、`story_retry_narration`、`story_retry_turn`。`story_send` 支持普通选项来源字段。

## 正文检查边界

普通无异常回合不增加固定的模型调用。规则检查覆盖数字、已知人物/地点、否定、选定的状态与归属表达、信息确定性、部分选项提前执行表达。涉及重大选择后果、死亡/永久离场、不可逆关系变化、阶段结算，或出现疑似冲突时升级语义检查。

校验针对标题、正文和摘要，并在语义检查中同时核对初稿与候选稿。仅润色有问题时保留通过检查的初稿；初稿有问题则最多一次修订和复核。保守简述从已提交公开事件直接构造，使用中性标题。未经检查的正文不进入 SSE；原稿、候选、检查结果及最终文本保存在 `narration_attempts`/回合叙事状态中。

`rules`、`semantic`、`fallback` 分别显示“规则检查通过”“语义检查通过”“保守简述”。这些标签描述执行过的检查，不保证任意自然语言完全没有矛盾。语义校验仍可能漏检，普通规则也可能保守地触发额外校验。

`GET /stories/:id/metrics` 返回各节点调用次数和平均耗时，以及当前已发布正文版本的语义检查率、降级率和语义调用数；历史重试过程可由叙事审计记录追溯。

## 迁移与恢复

迁移前先写文件备份与 `story_save_backups` 数据库备份；失败则回滚该存档。重复启动不重复迁移。明确指定目录的测试数据库始终使用独立 PGlite，避免 `DATABASE_URL` 意外指向现有数据库。

旧未完成阶段的百分比仅保存为 `legacyProgress`，不会推断已经达成哪些条件。旧完成阶段保留历史结论，旧正文和事实原样保留；未完成的旧选择补建记录，已确认选择不补跑后果。迁移、里程碑、延期、结算和选择都有重放依据，世界哈希覆盖阶段证据、选择结果、人物关系和最终结束状态；正文重试不改变该哈希。

## 验收

```powershell
npm test
$env:PLAYWRIGHT_CHANNEL='chrome' # 或安装 Playwright Chromium 并省略此项
npm run test:ui
npm run build
npm run test:v2-smoke
```

自动化测试包括：并发选择、重复请求、旧证据补取、配置变更重新规划、越权行动、40 回合证据保留、阶段超时/延期/部分结算/失败/最终结束、否定反转/人物互换/数字变化/归属变化/猜测变定论/选项提前执行、语义回退与修订、正文重试、备份迁移、outbox 重投和数据库关闭重开恢复。

真实 LLM 冒烟使用确定性大纲夹具及真实 Codex 回合 Agent，在全新存档上完成关键选择、后续场景和正文重试。机器可读结果保存在 `reports/v2-smoke.json`；更长的真实模型验收可运行 `npm run test:three-day`，以 4320 故事分钟或最终结局为停止条件。

本次验证记录见 [v2 核心体验验收](../reports/acceptance/V2_CORE_ACCEPTANCE.md)。
