import { afterEach, expect, it } from 'vitest';
import { scenePlanSchema } from '../packages/contracts/index.ts';
import { StoryRuntime } from '../packages/agent-runtime/runtime.ts';
import type { StructuredAgentProvider } from '../packages/agent-runtime/provider.ts';
import { createActiveStory, fixture } from './helpers.ts';

const cleanups: Array<() => Promise<void>> = []; afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });
it('resumes after transactional commit without creating a duplicate scene', async () => {
  const value = await fixture(); cleanups.push(value.close); const storyId = await createActiveStory(value); const turn = await value.store.enqueueTurn(storyId, '测试恢复', 'test', 'recovery-0001'); await value.store.claim(turn.id);
  const context = await value.store.context(storyId); const protagonist = context.characters.find(character => character.importance === 'protagonist')!; const heroine = context.characters.find(character => character.roleTags.includes('heroine'))!;
  const plan = scenePlanSchema.parse({ title: '中断之前', objective: '提交一条可恢复的事实。', location: protagonist.location, participants: [protagonist.id, heroine.id], durationMinutes: 60, beats: ['提交事实'], changes: [{ type: 'fact', kind: 'action', text: '恢复测试事实已提交。', tags: ['recovery'] }], stageProgressDelta: 1, requiresPlayerChoice: false, choicePrompt: null, choices: [], checkTags: [] });
  await value.store.setTurnData(turn.id, 'plan', plan); await value.store.commitScene(turn.id, plan); await value.store.recordRecoverableError(turn.id, '模拟进程在提交后退出'); await value.store.recoverInterrupted(); await value.runtime.runTurn(turn.id);
  const state = await value.store.state(storyId); expect(state.scenes).toHaveLength(1); expect(state.clock).toBe(60); expect((await value.store.turn(turn.id)).status).toBe('completed');
});

it('interrupts a pre-commit Agent call for restart and replays it without a failed step', async () => {
  const value = await fixture(); cleanups.push(value.close); const storyId = await createActiveStory(value);
  const provider = { name: 'deterministic', run: (_role: string, _prompt: string, _schema: unknown, signal?: AbortSignal) => new Promise((_, reject) => {
    const rejectAbort = () => reject(signal?.reason ?? new Error('aborted')); signal?.addEventListener('abort', rejectAbort, { once: true });
  }) } as StructuredAgentProvider;
  const interruptedRuntime = new StoryRuntime(value.store, () => provider); await interruptedRuntime.start(); const turn = await value.store.enqueueTurn(storyId, '测试提交前重启', 'test', 'recovery-precommit-0001'); await value.store.flushOutbox();
  for (let attempt = 0; attempt < 150; attempt++) { const current = await value.store.turn(turn.id); if (current.status === 'directing') break; await new Promise(resolve => setTimeout(resolve, 10)); }
  const stopStarted = Date.now(); await interruptedRuntime.stop(); expect(Date.now() - stopStarted).toBeLessThan(2_000); const interrupted = await value.store.turn(turn.id);
  expect(interrupted.status).toBe('directing'); expect(interrupted.steps.some(step => step.status === 'failed')).toBe(false);
  await value.store.recoverInterrupted(); await value.runtime.runTurn(turn.id); const state = await value.store.state(storyId);
  expect((await value.store.turn(turn.id)).status).toBe('completed'); expect(state.scenes).toHaveLength(1); expect(new Set(state.scenes.map(scene => scene.id)).size).toBe(1);
});

it('returns coherent story snapshots while the worker mutates turns and projections', async () => {
  const value = await fixture(); cleanups.push(value.close); const storyId = await createActiveStory(value); await value.runtime.start();
  try {
    await value.runtime.startAutoplay(storyId, { durationMinutes: 360, maxScenes: 2 }); const snapshots = [];
    for (let batch = 0; batch < 20; batch++) snapshots.push(...await Promise.all(Array.from({ length: 10 }, () => value.store.state(storyId))));
    expect(snapshots).toHaveLength(200); expect(snapshots.every(state => !state.latestTurn || state.latestTurn.storyId === storyId)).toBe(true);
    expect(snapshots.every(state => new Set(state.scenes.map(scene => scene.id)).size === state.scenes.length)).toBe(true);
  } finally { await value.runtime.stop(); }
});

it('coalesces concurrent outbox flush requests into one queue dispatch', async () => {
  const value = await fixture(); cleanups.push(value.close); const storyId = await createActiveStory(value); await value.store.enqueueTurn(storyId, '测试 outbox single-flight', 'test', 'outbox-single-flight-0001');
  const boss = value.database.boss as any; const originalSend = boss.send.bind(boss); let sends = 0;
  boss.send = async (...args: any[]) => { sends += 1; await new Promise(resolveWait => setTimeout(resolveWait, 50)); return originalSend(...args); };
  try { await Promise.all(Array.from({ length: 100 }, () => value.store.flushOutbox())); } finally { boss.send = originalSend; }
  expect(sends).toBe(1); const outbox = await value.database.pool.query('SELECT dispatched FROM story_outbox'); expect(outbox.rows.every(row => row.dispatched)).toBe(true);
});
