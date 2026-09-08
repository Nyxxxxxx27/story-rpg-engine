#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {resourceIntentSchema,outlineDraftSchema} from '../../packages/contracts/index.ts';
import {resourceSetupSchema} from '../../packages/storage/resource-store.ts';

const base = process.env.STORY_API_URL ?? 'http://127.0.0.1:4310/api/v2';
async function api(path: string, init?: RequestInit) {
  const response = await fetch(`${base}${path}`, { ...init, headers: { ...(init?.body ? { 'content-type': 'application/json' } : {}), ...init?.headers } });
  const body = await response.json(); if (!response.ok) throw new Error(`${response.status}: ${body.error ?? JSON.stringify(body)}`); return body;
}
const result = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }], structuredContent: { result: value } });
const server = new McpServer({ name: 'story-rpg-engine', version: '2.0.0' });

server.registerTool('story_create', { description: '创建一个可跨题材的本地长线故事草稿。创建后先生成并确认大纲。', inputSchema: {
  title: z.string().min(1), genre: z.enum(['cultivation', 'western_fantasy', 'science_fiction', 'modern_mystery', 'custom']), premise: z.string().min(1),
  romanceMode:z.enum(['off','player_led','organic']).default('organic'),rulesAtStart:z.boolean().default(true),fastReview:z.boolean().default(true),
  tone: z.string().default('沉浸、克制、重视人物选择'), pacing: z.enum(['slow', 'balanced', 'fast']).default('balanced'),
  storyPacks: z.array(z.string()).default(['generic-story']), advancedPrompt: z.string().default(''), provider: z.enum(['codex', 'openai', 'deterministic']).default('codex'), seed: z.number().int().positive().optional(),
} }, async input => result(await api('/stories', { method: 'POST', body: JSON.stringify({ seed: input.seed, config: { title: input.title, genre: input.genre, premise: input.premise, tone: input.tone, pacing: input.pacing, worldRules: [], terminology: {}, contentBoundaries: [], storyPacks: input.storyPacks, advancedPrompt: input.advancedPrompt, provider: input.provider,romanceMode:input.romanceMode,rulesAtStart:input.rulesAtStart,fastReview:input.fastReview } }) })));

server.registerTool('story_generate_outline', { description: '使用故事选择的 Agent Provider 随机生成可编辑大纲，包含长期主线、约 8 个分支节点和核心人物。', inputSchema: { storyId: z.string().uuid() } }, async ({ storyId }) => result(await api(`/stories/${storyId}/outline/generate`, { method: 'POST' })));
server.registerTool('story_confirm_outline', { description: '确认已生成的大纲并创建正式世界。', inputSchema: { storyId: z.string().uuid() } }, async ({ storyId }) => result(await api(`/stories/${storyId}/outline/confirm`, { method: 'POST' })));
server.registerTool('story_send', { description: '向故事发送玩家行动；网页和 Codex 共用相同回合协议。', inputSchema: { storyId: z.string().uuid(), input: z.string().min(1), resourceIntent:resourceIntentSchema.optional(), sceneId: z.string().uuid().optional(), optionId: z.string().optional(), idempotencyKey: z.string().min(8).optional() } }, async ({ storyId, input, sceneId, optionId, idempotencyKey,resourceIntent }) => result(await api(`/stories/${storyId}/turns`, { method: 'POST', body: JSON.stringify({ input, sceneId, optionId, resourceIntent, source: 'codex', idempotencyKey: idempotencyKey ?? `codex-${crypto.randomUUID()}` }) })));
server.registerTool('story_wait', { description: '等待某个回合完成、暂停或失败，并返回 Agent 节点和场景。', inputSchema: { storyId: z.string().uuid(), turnId: z.string().uuid(), timeoutSeconds: z.number().int().min(1).max(1800).default(1200) } }, async ({ storyId, turnId, timeoutSeconds }) => {
  const deadline = Date.now() + timeoutSeconds * 1000; let turn: any;
  do { turn = await api(`/stories/${storyId}/turns/${turnId}`); if (['completed', 'waiting_player', 'failed'].includes(turn.status)) break; await new Promise(resolve => setTimeout(resolve, 500)); } while (Date.now() < deadline);
  return result(turn);
});
server.registerTool('story_get_state', { description: '读取长期主线、阶段、人物、关系、事实、场景和托管状态。', inputSchema: { storyId: z.string().uuid() } }, async ({ storyId }) => result(await api(`/stories/${storyId}`)));
server.registerTool('story_set_stage', { description: '编辑一个阶段的目标、完成条件和边界，历史事实不变。', inputSchema: { storyId: z.string().uuid(), stageId: z.string().uuid(), objective: z.string().min(1), completionCriteria: z.array(z.string().min(1)).min(1), boundaries: z.array(z.string()).optional() } }, async ({ storyId, stageId, objective, completionCriteria, boundaries }) => {
  const state = await api(`/stories/${storyId}`); const stage = state.stages.find((item: any) => item.id === stageId); if (!stage) throw new Error('Stage not found');
  return result(await api(`/stories/${storyId}/stages/${stageId}`, { method: 'PUT', body: JSON.stringify({ ...stage, objective, completionCriteria, boundaries: boundaries ?? stage.boundaries }) }));
});
server.registerTool('story_review_stage_proposal', { description: '接受或拒绝下一阶段提案；接受后可继续暂停中的托管。', inputSchema: { storyId: z.string().uuid(), proposalId: z.string().uuid(), decision: z.enum(['accept', 'reject']) } }, async ({ storyId, proposalId, decision }) => result(await api(`/stories/${storyId}/stage-proposal/${proposalId}/review`, { method: 'POST', body: JSON.stringify({ decision }) })));
server.registerTool('story_start_autoplay', { description: '按故事内时间启动托管，范围 1 小时至 30 天，最多 50 个场景。', inputSchema: { storyId: z.string().uuid(), durationMinutes: z.number().int().min(60).max(43200), maxScenes: z.number().int().min(1).max(50).default(50) } }, async ({ storyId, durationMinutes, maxScenes }) => result(await api(`/stories/${storyId}/autoplay`, { method: 'POST', body: JSON.stringify({ durationMinutes, maxScenes }) })));
server.registerTool('story_stop_autoplay', { description: '停止一个故事的托管。', inputSchema: { storyId: z.string().uuid() } }, async ({ storyId }) => result(await api(`/stories/${storyId}/autoplay`, { method: 'DELETE' })));

server.registerTool('story_resolve_choice', { description: '确认关键选择并自动执行一场后果；原托管保持暂停。重复请求必须复用幂等键。', inputSchema: {
  storyId: z.string().uuid(), decisionId: z.string().uuid(), optionId: z.string().optional(), choice: z.string().min(1).max(4000).optional(), idempotencyKey: z.string().min(8),
} }, async ({ storyId, ...body }) => result(await api(`/stories/${storyId}/choices/resolve`, { method: 'POST', body: JSON.stringify({ ...body, source: 'codex' }) })));
server.registerTool('story_resume_autoplay', { description: '玩家明确恢复已暂停的托管；须先处理选择和阶段事项。', inputSchema: { storyId: z.string().uuid() } }, async ({ storyId }) => result(await api(`/stories/${storyId}/autoplay/resume`, { method: 'POST' })));
server.registerTool('story_resolve_deadline', { description: '处理阶段超时：延期到新的绝对故事分钟，或按实际成果结束阶段。不会自动恢复托管。', inputSchema: {
  storyId: z.string().uuid(), stageId: z.string().uuid(), revision: z.number().int().positive(), action: z.enum(['extend', 'close']), deadlineMinutes: z.number().int().positive().optional(), idempotencyKey: z.string().min(8),
} }, async ({ storyId, stageId, ...body }) => result(await api(`/stories/${storyId}/stages/${stageId}/deadline/resolve`, { method: 'POST', body: JSON.stringify(body) })));
server.registerTool('story_retry_narration', { description: '仅重新生成已提交场景的正文，不重复行动，不改变世界状态。', inputSchema: { storyId: z.string().uuid(), sceneId: z.string().uuid(), idempotencyKey: z.string().min(8) } }, async ({ storyId, sceneId, idempotencyKey }) => result(await api(`/stories/${storyId}/scenes/${sceneId}/narration/retry`, { method: 'POST', body: JSON.stringify({ idempotencyKey }) })));
server.registerTool('story_retry_turn', { description: '重试失败的同一回合。提交过的行动不会再次执行。', inputSchema: { storyId: z.string().uuid(), turnId: z.string().uuid(), idempotencyKey: z.string().min(8) } }, async ({ storyId, turnId, idempotencyKey }) => result(await api(`/stories/${storyId}/turns/${turnId}/retry`, { method: 'POST', body: JSON.stringify({ idempotencyKey }) })));

server.registerTool('story_history', { description: '分页读取已发布历史；历史选项不能直接执行。', inputSchema: { storyId: z.string().uuid(), cursor: z.string().optional(), limit: z.number().int().min(1).max(100).default(20) } }, async ({ storyId, cursor, limit }) => result(await api(`/stories/${storyId}/history?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)));
server.registerTool('story_memory_search', { description: '检索人物、地点、承诺与旧事实，返回来源。', inputSchema: { storyId: z.string().uuid(), query: z.string().max(4000).default('') } }, async ({ storyId, query }) => result(await api(`/stories/${storyId}/memory?q=${encodeURIComponent(query)}`)));
server.registerTool('story_memory_index', { description: '暂停或继续固定历史范围的后台整理，不执行行动。', inputSchema: { storyId: z.string().uuid(), action: z.enum(['pause', 'resume']) } }, async ({ storyId, action }) => result(await api(`/stories/${storyId}/memory/index`, { method: 'POST', body: JSON.stringify({ action }) })));
server.registerTool('story_actions', { description: '读取玩家行动及对应后果。', inputSchema: { storyId: z.string().uuid(), before: z.number().optional(),cursor:z.string().optional() } }, async ({ storyId, before,cursor }) => result(await api(`/stories/${storyId}/actions${cursor?`?cursor=${encodeURIComponent(cursor)}`:before ? `?before=${before}` : ''}`)));
server.registerTool('story_chapters', { description: '读取已经进入的章节及事件回顾。', inputSchema: { storyId: z.string().uuid() } }, async ({ storyId }) => result(await api(`/stories/${storyId}/chapters`)));
server.registerTool('story_recap', { description: '按需生成有事实来源的章节回顾，不推进世界。', inputSchema: { storyId: z.string().uuid(), stageId: z.string().uuid() } }, async ({ storyId, stageId }) => result(await api(`/stories/${storyId}/chapters/${stageId}/recap`, { method: 'POST' })));
server.registerTool('story_checkpoints', { description: '列出可以导出或分叉的历史检查点。', inputSchema: { storyId:z.string().uuid() } },async({storyId})=>result(await api(`/stories/${storyId}/checkpoints`)));
server.registerTool('story_export_save', { description: '返回检查点存档 JSON。包含历史和私人剧情资料，不包含账户凭据。', inputSchema: { storyId:z.string().uuid(),checkpointId:z.string().uuid().optional() } },async({storyId,checkpointId})=>result(await api(`/stories/${storyId}/save${checkpointId ? `?checkpointId=${checkpointId}` : ''}`)));
server.registerTool('story_import_save', { description: '从导出的 JSON 创建新存档，不执行历史行动；复用幂等键避免重复导入。', inputSchema: { archive:z.record(z.string(),z.unknown()),idempotencyKey:z.string().min(8) } },async body=>result(await api('/saves/import',{method:'POST',body:JSON.stringify(body)})));
server.registerTool('story_fork', { description: '从可恢复节点创建独立分支，保持父存档和历史随机状态。', inputSchema: { storyId:z.string().uuid(),checkpointId:z.string().uuid(),idempotencyKey:z.string().min(8) } },async({storyId,...body})=>result(await api(`/stories/${storyId}/forks`,{method:'POST',body:JSON.stringify(body)})));
server.registerTool('story_resource_panel',{description:'查看角色面板、登记障碍和历史判定。',inputSchema:{storyId:z.string().uuid()}},async({storyId})=>result(await api('/stories/'+storyId+'/resources')));
server.registerTool('story_action_quote',{description:'查看登记行动的成本、难度和成功机会，不掷骰、不执行。',inputSchema:{storyId:z.string().uuid(),intent:resourceIntentSchema}},async({storyId,intent})=>result(await api('/stories/'+storyId+'/resources/quote',{method:'POST',body:JSON.stringify(intent)})));
server.registerTool('story_enable_resources',{description:'确认初始面板后从当前节点启用资源，不倒算历史。',inputSchema:{storyId:z.string().uuid(),setup:resourceSetupSchema}},async({storyId,setup})=>result(await api('/stories/'+storyId+'/resources/enable',{method:'POST',body:JSON.stringify(setup)})));
server.registerTool('story_routes',{description:'查看当前已开放路线，所有路线均需要明确确认。',inputSchema:{storyId:z.string().uuid()}},async({storyId})=>result(await api('/stories/'+storyId+'/stage-proposal')));
server.registerTool('story_edit_graph',{description:'编辑未执行的大纲节点和连接，完整大纲包含剧透。',inputSchema:{storyId:z.string().uuid(),revision:z.number().int().positive(),outline:outlineDraftSchema}},async({storyId,...body})=>result(await api('/stories/'+storyId+'/graph',{method:'PUT',body:JSON.stringify(body)})));
server.registerTool('story_npc_activity',{description:'查看玩家已知的人物动态与预警。',inputSchema:{storyId:z.string().uuid()}},async({storyId})=>result(await api('/stories/'+storyId+'/npcs')));
server.registerTool('story_metrics',{description:'读取实测耗时、模型请求及未知用量。',inputSchema:{storyId:z.string().uuid()}},async({storyId})=>result(await api('/stories/'+storyId+'/metrics')));
server.registerTool('story_rebuild_checkpoint',{description:'以完整初始化快照和历史事件重建指定场景节点；证据不足的旧节点拒绝分叉。',inputSchema:{storyId:z.string().uuid(),sceneId:z.string().uuid()}},async({storyId,sceneId})=>result(await api('/stories/'+storyId+'/checkpoints/rebuild',{method:'POST',body:JSON.stringify({sceneId})})));
await server.connect(new StdioServerTransport());
