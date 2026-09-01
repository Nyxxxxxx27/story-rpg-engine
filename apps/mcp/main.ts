#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const base = process.env.STORY_API_URL ?? 'http://127.0.0.1:4310/api/v2';
async function api(path: string, init?: RequestInit) {
  const response = await fetch(`${base}${path}`, { ...init, headers: { ...(init?.body ? { 'content-type': 'application/json' } : {}), ...init?.headers } });
  const body = await response.json(); if (!response.ok) throw new Error(`${response.status}: ${body.error ?? JSON.stringify(body)}`); return body;
}
const result = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }], structuredContent: { result: value } });
const server = new McpServer({ name: 'story-rpg-engine', version: '1.0.0' });

server.registerTool('story_create', { description: '创建一个可跨题材的本地长线故事草稿。创建后先生成并确认大纲。', inputSchema: {
  title: z.string().min(1), genre: z.enum(['cultivation', 'western_fantasy', 'science_fiction', 'modern_mystery', 'custom']), premise: z.string().min(1),
  tone: z.string().default('沉浸、克制、重视人物选择'), pacing: z.enum(['slow', 'balanced', 'fast']).default('balanced'),
  storyPacks: z.array(z.string()).default(['generic-story']), advancedPrompt: z.string().default(''), provider: z.enum(['codex', 'openai', 'deterministic']).default('codex'), seed: z.number().int().positive().optional(),
} }, async input => result(await api('/stories', { method: 'POST', body: JSON.stringify({ seed: input.seed, config: { title: input.title, genre: input.genre, premise: input.premise, tone: input.tone, pacing: input.pacing, worldRules: [], terminology: {}, contentBoundaries: [], storyPacks: input.storyPacks, advancedPrompt: input.advancedPrompt, provider: input.provider } }) })));

server.registerTool('story_generate_outline', { description: '使用故事选择的 Agent Provider 随机生成可编辑大纲，包含长期主线、4–6 阶段和核心人物。', inputSchema: { storyId: z.string().uuid() } }, async ({ storyId }) => result(await api(`/stories/${storyId}/outline/generate`, { method: 'POST' })));
server.registerTool('story_confirm_outline', { description: '确认已生成的大纲并创建正式世界。', inputSchema: { storyId: z.string().uuid() } }, async ({ storyId }) => result(await api(`/stories/${storyId}/outline/confirm`, { method: 'POST' })));
server.registerTool('story_send', { description: '向故事发送玩家行动；网页和 Codex 共用相同回合协议。', inputSchema: { storyId: z.string().uuid(), input: z.string().min(1), idempotencyKey: z.string().min(8).optional() } }, async ({ storyId, input, idempotencyKey }) => result(await api(`/stories/${storyId}/turns`, { method: 'POST', body: JSON.stringify({ input, source: 'codex', idempotencyKey: idempotencyKey ?? `codex-${crypto.randomUUID()}` }) })));
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

await server.connect(new StdioServerTransport());
