import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { connectDatabase } from '../packages/storage/database.ts';
import { StoryStore } from '../packages/storage/store.ts';
import { StoryRuntime } from '../packages/agent-runtime/runtime.ts';
import { codexProvider, deterministicProvider } from '../packages/agent-runtime/provider.ts';
import { storyDeterministicGenerator } from '../packages/agent-runtime/deterministic.ts';

// A fresh save for every run; the outline fixture keeps the smoke focused on real turn agents.
const directory = resolve(`.data/v2-smoke-${randomUUID()}`);
const database = await connectDatabase({ directory }); const store = new StoryStore(database); await store.setup();
const real = codexProvider(); const runtime = new StoryRuntime(store, () => real);
const report: Record<string, unknown> = { startedAt: new Date().toISOString(), directory, provider: 'codex', outline: 'deterministic fixture', passed: false };
try {
  const config = { title: '核心体验真实模型冒烟', genre: 'science_fiction' as const, premise: '主角与同行者在办公室核对公共观测日志，查明一次时间记录异常。', tone: '克制清晰', pacing: 'balanced' as const, worldRules: ['调查结果必须有具体证据'], terminology: {}, contentBoundaries: [], storyPacks: ['generic-story'], advancedPrompt: '', provider: 'codex' as const, polishMode: 'standard' as const, romanceMode: 'organic' as const, fastReview: false, rulesAtStart: false };
  const created = await store.create('smoke', config, 20260906); report.storyId = created.storyId;
  const setup = new StoryRuntime(store, () => deterministicProvider(storyDeterministicGenerator));
  const outline = await setup.generateOutline(created.storyId, 'smoke');
  outline.stages[0].entryCriteria = ['玩家选择接下来的调查路线'];
  outline.stages[0].completionCriteria = ['两人共同核实一条公共观测记录', '取得并交叉核实外地档案室的原始备份'];
  await store.confirmOutline(created.storyId, 'smoke', outline);
  const opening = await store.enqueueTurn(created.storyId, '先与同行者讨论两种可撤回的核验路线，让我选定后再执行。', 'test', 'smoke-opening');
  console.log(`[v2-smoke] real opening ${opening.id}`); await runtime.runTurn(opening.id);
  let state = await store.state(created.storyId); assert.equal(state.latestTurn?.error, null); assert.ok(state.pendingDecision);
  const request = { decisionId: state.pendingDecision.id, choice: '我选择留在当前办公室，与同行者一起核对已经摆在桌上的公共记录，只标注直接可见的时间差异。', idempotencyKey: 'smoke-choice', source: 'test' as const };
  const responses = await Promise.all([store.resolveChoice(created.storyId, request), store.resolveChoice(created.storyId, request)]);
  assert.equal(responses[0].continuationTurnId, responses[1].continuationTurnId);
  console.log(`[v2-smoke] real consequence ${responses[0].continuationTurnId}`); await runtime.runTurn(responses[0].continuationTurnId);
  state = await store.state(created.storyId); assert.equal(state.latestTurn?.error, null); assert.equal(state.scenes.length, 2);
  const hashes = await store.stateHashes(created.storyId); assert.equal(hashes.matches, true);
  const beforeFacts = (await database.pool.query('SELECT count(*)::int AS n FROM facts WHERE story_id=$1', [created.storyId])).rows[0].n;
  const scene = state.scenes.at(-1)!; console.log(`[v2-smoke] real narration-only retry ${scene.id}`);
  await store.retrySceneNarration(created.storyId, scene.id, 'smoke-narration-retry'); await runtime.runTurn(scene.turnId);
  const after = await store.stateHashes(created.storyId); assert.equal(after.stateHash, hashes.stateHash);
  assert.equal((await database.pool.query('SELECT count(*)::int AS n FROM facts WHERE story_id=$1', [created.storyId])).rows[0].n, beforeFacts);
  assert.equal((await database.pool.query("SELECT count(*)::int AS n FROM facts WHERE story_id=$1 AND payload->>'type'='player_choice'", [created.storyId])).rows[0].n, 1);
  report.passed = true; report.hashes = after; report.metrics = await store.metrics(created.storyId); report.scenes = (await store.state(created.storyId)).scenes;
  console.log('[v2-smoke] PASS');
} catch (error) { report.error = error instanceof Error ? error.message : String(error); throw error; }
finally {
  report.completedAt = new Date().toISOString(); await mkdir(resolve('reports'), { recursive: true });
  await writeFile(resolve('reports/v2-smoke.json'), JSON.stringify(report, null, 2));
  await real.close?.(); await database.close();
}
