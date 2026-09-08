import { CURRENT_SCHEMA_VERSION } from '../packages/storage/experience-store.ts';
import { afterEach, describe, expect, it } from 'vitest';
import { scenePlanSchema, storyStageSchema, stageReviewSchema } from '../packages/contracts/index.ts';
import { StoryRuntime, stageTimeBoundary } from '../packages/agent-runtime/runtime.ts';
import { deterministicProvider, type StructuredAgentProvider } from '../packages/agent-runtime/provider.ts';
import { storyDeterministicGenerator } from '../packages/agent-runtime/deterministic.ts';
import { layeredPrompt } from '../packages/agent-runtime/prompts.ts';
import { createActiveStory, fixture } from './helpers.ts';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });
async function setup() { const value = await fixture(); cleanups.push(value.close); const storyId = await createActiveStory(value); return { ...value, storyId }; }
const base = deterministicProvider(storyDeterministicGenerator);
function provider(override: (role: string, prompt: string, result: any) => any | Promise<any>): StructuredAgentProvider {
  return { name: 'deterministic', async run(role, prompt, schema, signal) { const result = await base.run(role, prompt, schema, signal); return schema.parse(await override(role, prompt, result)); } };
}
const noMilestones = provider((role, _prompt, result) => role === 'Stage Agent' ? { ...result, milestones: [], failure: null } : result);
async function run(value: Awaited<ReturnType<typeof setup>>, input = '核对记录', runtime = value.runtime) {
  const turn = await value.store.enqueueTurn(value.storyId, input, 'test', crypto.randomUUID()); await runtime.runTurn(turn.id); return value.store.turn(turn.id);
}
function decisionProvider(extra?: (role: string, prompt: string, result: any) => any): StructuredAgentProvider {
  return provider((role, prompt, result) => {
    if (extra) result = extra(role, prompt, result);
    if (role === 'Stage Agent') return { ...result, milestones: [] };
    if (role === 'Director Agent' && !prompt.includes('<confirmed_decision>')) return { ...result, requiresPlayerChoice: true, choicePrompt: '先核对哪份记录？', choices: ['核对北侧记录', '核对南侧记录'] };
    return result;
  });
}

describe('story-v2 decisions and milestones', () => {
  it('uses only explicit deadlines and creates independent milestones', async () => {
    const value = await setup(); const state = await value.store.state(value.storyId);
    expect(state.schemaVersion).toBe(CURRENT_SCHEMA_VERSION); expect(state.activeStage!.milestones).toHaveLength(2);
    expect(stageTimeBoundary(storyStageSchema.parse({ ...state.activeStage, title: '第一天', deadlineMinutes: null }))).toBeNull();
    expect(stageTimeBoundary(storyStageSchema.parse({ ...state.activeStage, deadlineMinutes: 2000 }))).toBe(2000);
  });

  it('commits evidence-backed milestones and includes arc and relationship context', async () => {
    const value = await setup(); const turn = await run(value); const state = await value.store.state(value.storyId);
    expect(turn.error).toBeNull(); expect(turn.status).toBe('completed'); expect(state.activeStage!.progress).toBe(50);
    expect(state.activeStage!.milestones[0].evidenceFactIds).toHaveLength(1);
    expect(state.scenes[0].validation?.semanticCalls).toBe(0);
    const context = await value.store.context(value.storyId);
    const prompt = layeredPrompt('Director Agent', context, '测试', scenePlanSchema);
    expect(prompt).toContain(context.arc.objective); expect(prompt).toContain('<relationships>'); expect(prompt).toContain('<story_clock>360</story_clock>');
    expect((await value.store.stateHashes(value.storyId)).matches).toBe(true);
  });

  it('shows stable ordinary options and rejects stale option execution', async () => {
    const value = await setup(); const first = await run(value); const option = first.scene!.options[0];
    const turn = await value.store.enqueueTurn(value.storyId, option.text, 'web', 'ordinary-option-001', { sceneId: first.scene!.id, optionId: option.id });
    expect((await value.store.enqueueTurn(value.storyId, option.text, 'web', 'ordinary-option-001')).id).toBe(turn.id);
    await value.runtime.runTurn(turn.id);
    await expect(value.store.enqueueTurn(value.storyId, option.text, 'web', 'stale-option-001', { sceneId: first.scene!.id, optionId: option.id })).rejects.toThrow();
  });

  it('atomically resolves concurrent choices into exactly one continuation', async () => {
    const value = await setup(); const runtime = new StoryRuntime(value.store, () => decisionProvider());
    const first = await run(value, '选择调查方向', runtime); expect(first.status).toBe('waiting_player');
    const decision = (await value.store.state(value.storyId)).pendingDecision!;
    const request = { decisionId: decision.id, optionId: decision.options[0].id, idempotencyKey: 'resolve-concurrent-001', source: 'web' as const };
    const results = await Promise.all(Array.from({ length: 8 }, () => value.store.resolveChoice(value.storyId, request)));
    expect(new Set(results.map(item => item.continuationTurnId)).size).toBe(1);
    const facts = await value.database.pool.query("SELECT id FROM facts WHERE story_id=$1 AND payload->>'type'='player_choice'", [value.storyId]); expect(facts.rows).toHaveLength(1);
    await runtime.runTurn(results[0].continuationTurnId); await runtime.runTurn(results[0].continuationTurnId);
    const state = await value.store.state(value.storyId); expect(state.scenes).toHaveLength(2); expect(state.latestTurn!.status).toBe('completed');
    expect((await value.database.pool.query("SELECT id FROM story_turns WHERE story_id=$1 AND status='queued'", [value.storyId])).rows).toHaveLength(0);
    await expect(value.store.resolveChoice(value.storyId, { ...request, choice: '改变主意' })).rejects.toThrow();
    expect((await value.store.stateHashes(value.storyId)).matches).toBe(true);
  });

  it('routes free text through a pending decision and survives commit-to-outbox recovery', async () => {
    const value = await setup(); const runtime = new StoryRuntime(value.store, () => decisionProvider()); await run(value, '开局', runtime);
    const continuation = await value.store.enqueueTurn(value.storyId, '自定义：先询问同行者', 'codex', 'custom-choice-001');
    expect(continuation.decisionId).not.toBeNull();
    await value.store.recoverInterrupted(); await runtime.runTurn(continuation.id);
    expect((await value.store.state(value.storyId)).scenes).toHaveLength(2);
    expect((await value.store.enqueueTurn(value.storyId, '自定义：先询问同行者', 'codex', 'custom-choice-001')).id).toBe(continuation.id);
  });

  it('keeps autoplay paused after a choice continuation and resumes only explicitly', async () => {
    const value = await setup(); const runtime = new StoryRuntime(value.store, () => decisionProvider());
    await runtime.startAutoplay(value.storyId, { durationMinutes: 1440, maxScenes: 10 });
    const queued = (await value.database.pool.query("SELECT id FROM story_turns WHERE story_id=$1 AND status='queued'", [value.storyId])).rows[0];
    await runtime.runTurn(queued.id); const decision = (await value.store.state(value.storyId)).pendingDecision!;
    const resolved = await value.store.resolveChoice(value.storyId, { decisionId: decision.id, optionId: decision.options[0].id, source: 'web' });
    await runtime.runTurn(resolved.continuationTurnId);
    expect((await value.store.autoplay(value.storyId))!.status).toBe('paused');
    expect((await value.database.pool.query("SELECT id FROM story_turns WHERE story_id=$1 AND status='queued'", [value.storyId])).rows).toHaveLength(0);
    await runtime.resumeAutoplay(value.storyId); expect((await value.store.autoplay(value.storyId))!.status).toBe('running');
  });

  it('executes only covered major changes and stops for a new major decision', async () => {
    const value = await setup(); let covered = true;
    const custom = decisionProvider((role, prompt, result) => {
      if (role === 'Director Agent' && prompt.includes('<confirmed_decision>')) return { ...result, requiresPlayerChoice: false, changes: [{ type: 'character', characterId: 'protagonist', field: 'condition', value: '签下长期契约', significance: 'major' }] };
      if (role === 'Protagonist Agency Agent' && prompt.includes('<confirmed_decision>')) return { ...result, confirmedActionCovered: covered, authorizedChangeIndices: covered ? [0] : [] };
      return result;
    });
    const runtime = new StoryRuntime(value.store, () => custom); await run(value, '开局', runtime);
    let decision = (await value.store.state(value.storyId)).pendingDecision!;
    let resolution = await value.store.resolveChoice(value.storyId, { decisionId: decision.id, choice: '签下长期契约', source: 'web' });
    await runtime.runTurn(resolution.continuationTurnId);
    expect((await value.store.state(value.storyId)).characters.find(item => item.id === 'protagonist')!.condition).toBe('签下长期契约');
    expect((await value.store.turn(resolution.continuationTurnId)).status).toBe('completed');
    await run(value, '另一个选择', runtime); decision = (await value.store.state(value.storyId)).pendingDecision!; covered = false;
    resolution = await value.store.resolveChoice(value.storyId, { decisionId: decision.id, choice: '只查看契约', source: 'web' });
    await runtime.runTurn(resolution.continuationTurnId);
    expect((await value.store.turn(resolution.continuationTurnId)).status).toBe('waiting_player');
  });

  it('does not derive progress from model percentages or unsupported references', async () => {
    const value = await setup(); const runtime = new StoryRuntime(value.store, () => noMilestones);
    const turn = await run(value, '推进', runtime); expect(turn.error).toBeNull(); expect((await value.store.state(value.storyId)).activeStage!.progress).toBe(0);
    const context = await value.store.context(value.storyId); const second = await value.store.enqueueTurn(value.storyId, '伪造证据', 'test', 'invalid-evidence-001'); await value.store.claim(second.id);
    const plan = await base.run('Director Agent', layeredPrompt('Director Agent', context, '测试', scenePlanSchema), scenePlanSchema);
    const meta = (await value.database.pool.query("SELECT id FROM facts WHERE story_id=$1 AND payload->>'type'='scene_action' ORDER BY seq LIMIT 1",[value.storyId])).rows[0];
    await expect(value.store.commitScene(second.id, plan, { stage: stageReviewSchema.parse({ approved: true, summary: '伪造进度', issues: [], milestones: [{ milestoneId: context.stage!.milestones[0].id, evidence: [{ type: 'fact', factId: meta.id }], reason: '把目标当成果' }] }) })).rejects.toThrow('INVALID_MILESTONE_EVIDENCE');
    expect((await value.store.state(value.storyId)).scenes).toHaveLength(1);
  });

  it('pauses at an explicit deadline and lets the player extend or close without success', async () => {
    const value = await setup(); let state = await value.store.state(value.storyId);
    await value.store.editStage(value.storyId, { ...state.activeStage!, deadlineMinutes: 120 });
    const runtime = new StoryRuntime(value.store, () => noMilestones); const turn = await run(value, '核对记录', runtime);
    expect(turn.error).toBeNull(); state = await value.store.state(value.storyId);
    expect(state.clock).toBe(120); expect(state.activeStage!.awaitingDeadline).toBe(true); expect(state.activeStage!.progress).toBe(0);
    await expect(value.store.enqueueTurn(value.storyId, '越过期限', 'web', 'blocked-deadline-001')).rejects.toThrow('STAGE_DEADLINE_REQUIRES_REVIEW');
    const request = { revision: state.activeStage!.revision, action: 'extend' as const, deadlineMinutes: 240, idempotencyKey: 'deadline-extension-001' };
    const extended = await value.store.resolveDeadline(value.storyId, state.activeStage!.id, request);
    expect((await value.store.resolveDeadline(value.storyId, state.activeStage!.id, request)).eventId).toBe(extended.eventId);
    await run(value, '继续核对', runtime); state = await value.store.state(value.storyId);
    await value.store.resolveDeadline(value.storyId, state.activeStage!.id, { revision: state.activeStage!.revision, action: 'close', idempotencyKey: 'deadline-close-001' });
    state = await value.store.state(value.storyId); expect(state.activeStage!.status).toBe('closed'); expect(state.activeStage!.outcome).toBe('abandoned'); expect(state.activeStage!.progress).toBe(0);
    expect(await value.store.pendingProposal(value.storyId)).not.toBeNull(); expect((await value.store.stateHashes(value.storyId)).matches).toBe(true);
  });

  it('reassembles a changed config before commit and keeps history evidence beyond the recent window', async () => {
    const value = await setup(); let edited = false, directing = 0;
    const custom = provider(async (role, _prompt, result) => {
      if (role === 'Director Agent') directing++;
      if (role === 'Stage Agent') {
        if (!edited) { edited = true; const state = await value.store.state(value.storyId); await value.store.updateConfig(value.storyId, 'test', { ...state.config, tone: '新的基调' }); }
        return { ...result, milestones: [] };
      }
      return result;
    });
    const runtime = new StoryRuntime(value.store, () => custom); expect((await run(value, '开始', runtime)).error).toBeNull(); expect(directing).toBe(2);
    const evidenceId = (await value.store.state(value.storyId)).relationships.find(relationship => relationship.evidenceFactIds.length)!.evidenceFactIds[0];
    for (let i = 0; i < 9; i++) await run(value, `调查${i}`, runtime);
    const context = await value.store.context(value.storyId); expect(context.facts).toHaveLength(24); expect(context.facts.some(fact => fact.id === evidenceId)).toBe(false); expect(context.evidenceFacts.some(fact => fact.id === evidenceId)).toBe(true);
    expect(layeredPrompt('Director Agent', context, '测试', scenePlanSchema)).toContain(evidenceId);
  }, 60000);

  it('finishes the story after all stages and replays milestone snapshots', async () => {
    const value = await setup();
    for (let i = 0; i < 10; i++) {
      const turn = await run(value); expect(turn.error).toBeNull(); const proposal = await value.store.pendingProposal(value.storyId);
      if (proposal) await value.runtime.reviewStageProposal(value.storyId, proposal.id, 'accept');
    }
    const state = await value.store.state(value.storyId); expect(state.status).toBe('finished'); expect(state.stages.every(stage => stage.progress === 100 && stage.outcome === 'success')).toBe(true);
    await expect(value.store.enqueueTurn(value.storyId, '继续', 'web', 'after-ending-001')).rejects.toThrow('STORY_NOT_ACTIVE');
    expect((await value.store.stateHashes(value.storyId)).matches).toBe(true);
  }, 60000);

  it('reuses old milestone evidence across forty turns without counting it again, then partially settles', async () => {
    const value = await setup(); await run(value); const first = (await value.store.state(value.storyId)).activeStage!.milestones[0];
    const runtime = new StoryRuntime(value.store, () => provider((role, _prompt, result) => role === 'Stage Agent' ? { ...result, milestones: [{ milestoneId: first.id, evidence: [{ type: 'fact', factId: first.evidenceFactIds[0] }, { type: 'fact', factId: first.evidenceFactIds[0] }], reason: '同一项历史证据' }] } : result));
    for (let index = 0; index < 40; index++) {
      const turn = await run(value, `核对长线调查第${index + 1}次记录`, runtime); expect(turn.error).toBeNull();
      if (index % 10 === 0) { await value.store.recoverInterrupted(); expect((await value.store.stateHashes(value.storyId)).matches).toBe(true); }
    }
    let state = await value.store.state(value.storyId); expect(state.activeStage!.progress).toBe(50); expect(state.activeStage!.milestones[0].evidenceFactIds).toEqual(first.evidenceFactIds);
    const context = await value.store.context(value.storyId); expect(context.evidenceFacts.some(fact => fact.id === first.evidenceFactIds[0])).toBe(true); expect(context.scenes).toHaveLength(8);
    await value.store.editStage(value.storyId, { ...state.activeStage!, deadlineMinutes: state.clock }); state = await value.store.state(value.storyId);
    await value.store.resolveDeadline(value.storyId, state.activeStage!.id, { revision: state.activeStage!.revision, action: 'close', idempotencyKey: 'long-partial-close' });
    const proposal = (await value.store.pendingProposal(value.storyId))!; await value.runtime.reviewStageProposal(value.storyId, proposal.id, 'accept');
    const next = await value.store.context(value.storyId); expect(next.previousStages[0].outcome).toBe('partial'); expect(next.previousStages[0].progress).toBe(50);
    expect(layeredPrompt('Director Agent', next, '测试', scenePlanSchema)).toContain(next.previousStages[0].milestones[1].criterion);
    expect((await value.store.stateHashes(value.storyId)).matches).toBe(true);
  }, 120000);

  it('records a proven failure and retains its evidence in the next stage context', async () => {
    const value = await setup(); const state = await value.store.state(value.storyId);
    await value.store.editStage(value.storyId, { ...state.activeStage!, failureConditions: ['公共记录已被雨水浸坏，无法辨认'] });
    const runtime = new StoryRuntime(value.store, () => provider((role, _prompt, result) => {
      if (role === 'Director Agent') return { ...result, changes: [{ type: 'fact', kind: 'world', text: '公共记录已被雨水浸坏，无法辨认。', tags: ['evidence_lost'] }] };
      if (role === 'Stage Agent') return { ...result, milestones: [], failure: { conditionIndex: 0, evidence: [{ type: 'change', index: 0 }], reason: '雨水浸坏公共记录' } };
      return result;
    }));
    const turn = await run(value, '检查受雨水影响的记录', runtime); expect(turn.error).toBeNull();
    const after = await value.store.state(value.storyId); expect(after.activeStage!.outcome).toBe('failure'); expect(after.activeStage!.progress).toBe(0); expect(after.activeStage!.failureEvidenceFactIds).toHaveLength(1);
    expect(after.scenes[0].validation?.mode).toBe('semantic');
    await value.runtime.reviewStageProposal(value.storyId, (await value.store.pendingProposal(value.storyId))!.id, 'accept');
    expect((await value.store.context(value.storyId)).previousStages[0].failureReason).toBe('雨水浸坏公共记录');
    expect((await value.store.stateHashes(value.storyId)).matches).toBe(true);
  });

  it('rejects even a routine continuation when the confirmed scope review fails', async () => {
    const value = await setup(); const runtime = new StoryRuntime(value.store, () => decisionProvider((role, _prompt, result) => role === 'Protagonist Agency Agent' ? { ...result, confirmedActionCovered: false, authorizedChangeIndices: [] } : result));
    await run(value, '讨论路线', runtime); const decision = (await value.store.state(value.storyId)).pendingDecision!;
    const resolved = await value.store.resolveChoice(value.storyId, { decisionId: decision.id, choice: '只核对北侧记录', source: 'test' }); await runtime.runTurn(resolved.continuationTurnId);
    expect((await value.store.turn(resolved.continuationTurnId)).status).toBe('failed'); expect((await value.store.state(value.storyId)).scenes).toHaveLength(1);
    const retryRuntime = new StoryRuntime(value.store, () => decisionProvider()); await value.store.retryTurn(value.storyId, resolved.continuationTurnId, 'scope-retry-001'); await retryRuntime.runTurn(resolved.continuationTurnId);
    expect((await value.store.state(value.storyId)).scenes).toHaveLength(2);
    expect((await value.database.pool.query("SELECT id FROM facts WHERE story_id=$1 AND payload->>'type'='player_choice'", [value.storyId])).rows).toHaveLength(1);
  });
});
