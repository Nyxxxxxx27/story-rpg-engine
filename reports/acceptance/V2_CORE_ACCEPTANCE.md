# v2 核心体验验收

验证日期：2026-09-06。代码在当前工作区，未提交或推送到远端。

| 项目 | 结果 |
| --- | --- |
| 核心、里程碑、正文、迁移、MCP/API | 28 项通过 |
| 恢复、原有公开正文及 Provider | 10 项通过 |
| 浏览器 | 3 项通过（本机 Chrome，无头，隔离存档和端口） |
| 类型检查与生产构建 | 通过 |
| 真实 Codex 冒烟 | 通过（真实回合 Agent，确定性大纲夹具） |

自动回归合计 38 项。包括一个初始回合加 40 个后续回合的长线证据测试、数据库实际关闭重开后的唯一后续场景恢复，以及正文与里程碑的反例测试。

最后运行的测试命令：

```powershell
npm test -- tests/core.test.ts tests/v2-integrity.test.ts tests/v2-surfaces.test.ts
npm test -- tests/recovery.test.ts tests/public-narration.test.ts tests/provider.test.ts
$env:PLAYWRIGHT_CHANNEL='chrome'
npm run test:ui
npm run build
npm run typecheck
npm run test:v2-smoke
```

测试环境 Node.js 22.19.0；项目声明的运行要求仍为 Node.js 24+，本次未单独运行 Node.js 24 环境。

## 真实模型样本

- 开始：2026-09-06T12:40:01.904Z
- 完成：2026-09-06T12:42:45.535Z
- 故事：`14a9b3af-d4ae-48b6-a933-a0549b532edf`
- 提交场景：2；重复确认只产生 1 条选择事实与 1 个后续回合。
- 正文重试：同一场景完成一次重写，无新增行动、场景或事实。
- 已发布正文降级率：0%（仅这两个样本，不代表总体质量）。
- 状态重放一致：`True`。
- 状态哈希：`07d996f35e2cd08c1c5b6dd6085879b35ae45d46f21cbaf7438028522453e67f`。

完整样本、逐节点耗时和最终正文见 [v2-core-smoke.json](v2-core-smoke.json)。普通无异常回合不增加语义调用，由确定性回归测试验证；真实样本均为关键选择场景，不能据此估算普通回合的触发率。

可选的长时间真实模型 `test:three-day` 驱动器已适配 v2 暂停及最终结局协议，并通过类型检查，本次未执行该耗时验收。

## 限制

规则检查覆盖已测试的冲突表达，不证明任意自然语言的事实一致性；语义检查也可能漏检。保守简述和叙事重试用于保证失败时仍可继续游戏，同时避免再次执行行动。
