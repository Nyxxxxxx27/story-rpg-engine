import { afterEach, describe, expect, it } from 'vitest';
import { outlineDraftSchema } from '../packages/contracts/index.ts';
import { StoryRuntime, stageTimeBoundary } from '../packages/agent-runtime/runtime.ts';
import { deterministicProvider } from '../packages/agent-runtime/provider.ts';
import { storyDeterministicGenerator } from '../packages/agent-runtime/deterministic.ts';
import { createActiveStory, fixture } from './helpers.ts';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

describe('story-v1 core', () => {
  it('reads stage deadlines only from explicit stage constraints', () => {
    const base = { id: crypto.randomUUID(), position: 1, status: 'active' as const, progress: 0, revision: 1, entryCriteria: [], failureConditions: [], boundaries: [], desiredBeats: [] };
    expect(stageTimeBoundary({ ...base, title: '第二阶段：旧案回声', objective: '承接首日取得的线索。', completionCriteria: ['确认新证据'] })).toBeNull();
    expect(stageTimeBoundary({ ...base, title: '第二日：旧案回声', objective: '确认新证据。', completionCriteria: ['取得旁证'] })).toBe(2880);
    expect(stageTimeBoundary({ ...base, title: '核验阶段', objective: '在第一日结束前取得旁证。', completionCriteria: ['记录异常'] })).toBe(1440);
    expect(stageTimeBoundary({ ...base, title: '第一阶段：异常记录', objective: '在故事首日确认资料存在矛盾。', completionCriteria: ['取得线索'] })).toBe(1440);
  });
  it('generates an editable genre-safe outline with stages and a tagged core relationship', async () => {
    const value = await fixture(); cleanups.push(value.close); const created = await value.store.create('test', { ...(await import('./helpers.ts')).testConfig('science_fiction'), title: '静默轨道' }, 42);
    const draft = outlineDraftSchema.parse(await value.runtime.generateOutline(created.storyId, 'test'));
    expect(draft.stages).toHaveLength(5); expect(draft.characters.filter(character => character.importance === 'protagonist')).toHaveLength(1);
    expect(draft.characters.some(character => character.roleTags.includes('heroine') || character.roleTags.includes('love_interest'))).toBe(true);
    expect(JSON.stringify(draft)).not.toMatch(/宗门|灵力|境界/);
  });

  it('runs the fixed pipeline and commits only traceable state changes', async () => {
    const value = await fixture(); cleanups.push(value.close); const storyId = await createActiveStory(value);
    const turn = await value.store.enqueueTurn(storyId, '与核心同行者核对第一条线索。', 'test', 'test-turn-0001'); await value.runtime.runTurn(turn.id);
    const finished = await value.store.turn(turn.id); const state = await value.store.state(storyId, 'test');
    expect(finished.error).toBeNull(); expect(finished.status).toBe('completed'); expect(state.clock).toBe(360); expect(state.scenes).toHaveLength(1);
    expect(finished.steps.map(step => step.name)).toEqual(expect.arrayContaining(['assembling', 'directing', 'continuity', 'stage', 'agency', 'character', 'pack', 'committing', 'narrating', 'polishing', 'summarizing']));
    expect(state.facts.length).toBeGreaterThanOrEqual(3); expect(state.facts.every(fact => fact.sourceTurnId === turn.id)).toBe(true);
    expect(state.relationships.some(relation => relation.trust === 1 && relation.evidenceFactIds.length === 1)).toBe(true);
  });

  it('advances exactly 4320 story minutes and pauses for stage proposals', async () => {
    const value = await fixture(); cleanups.push(value.close); const storyId = await createActiveStory(value, 'modern_mystery'); const start = (await value.store.state(storyId)).clock;
    await value.runtime.startAutoplay(storyId, { durationMinutes: 4320, maxScenes: 50 }); let proposals = 0;
    for (let safety = 0; safety < 40; safety++) {
      const queued = await value.database.pool.query("SELECT id FROM story_turns WHERE story_id=$1 AND status IN ('queued','narrating','summarizing') ORDER BY created_at,id LIMIT 1", [storyId]);
      if (queued.rows[0]) await value.runtime.runTurn(queued.rows[0].id);
      const session = await value.store.autoplay(storyId); if (session?.status === 'completed') break;
      if (session?.status === 'paused') { const proposal = await value.store.pendingProposal(storyId); expect(proposal).toBeTruthy(); proposals += 1; await value.runtime.reviewStageProposal(storyId, proposal!.id, 'accept'); }
    }
    const state = await value.store.state(storyId); expect(state.autoplay?.status).toBe('completed'); expect(state.clock - start).toBe(4320); expect(state.autoplay?.scenes).toBe(12); expect(state.scenes).toHaveLength(12); expect(proposals).toBeGreaterThanOrEqual(2); const authorization = await value.database.pool.query("SELECT id FROM facts WHERE story_id=$1 AND payload->>'type'='autoplay_authorized'", [storyId]); expect(authorization.rows).toHaveLength(1);
    const heroine = state.characters.find(character => character.roleTags.includes('heroine'))!; expect(state.scenes.filter(scene => scene.participants.includes(heroine.id)).length).toBeGreaterThanOrEqual(2);
    const hashes = await value.store.stateHashes(storyId); expect(hashes.matches).toBe(true);
  });

  it('preserves an explicit stage-required player decision during autoplay', async () => {
    const value = await fixture(); cleanups.push(value.close); const storyId = await createActiveStory(value, 'modern_mystery'); const state = await value.store.state(storyId); const stage = state.activeStage!; const originalLocations = new Map(state.characters.map(character => [character.id, character.location])); const protagonist = state.characters.find(character => character.importance === 'protagonist')!;
    await value.store.editStage(storyId, { ...stage, progress: 90, completionCriteria: [...stage.completionCriteria, '玩家决定优先调查资料、现场或相关人物'] });
    const base = deterministicProvider(storyDeterministicGenerator); const provider = {
      name: 'deterministic' as const,
      async run(role: string, prompt: string, schema: any, signal?: AbortSignal) {
        const result: any = await base.run(role, prompt, schema, signal);
        if (role === 'Continuity Agent') return schema.parse({ approved: false, summary: '错误地把本场候选事件当成旧事实。', issues: [
          { code: 'world_rule_violation', message: '当前尚无已提交事实证明异常已确认；应先通过本场行动、观察或台词产生这些事实。', severity: 'blocking' },
          { code: 'fact_contradiction', message: '变更事实称核对完成并提交已确认事实，但当前候选场景尚未执行核对或提交。', severity: 'blocking' },
        ] });
        return role === 'Director Agent' ? schema.parse({ ...result, location: '尚未选择的远方路线', participants: state.characters.map(character => character.id), durationMinutes: 360, beats: ['第0至420分钟前往远方路线并执行选择结果。'], changes: [...result.changes, ...state.characters.map(character => ({ type: 'character', characterId: character.id, field: 'location', value: '尚未选择的远方路线', significance: 'minor' }))], requiresPlayerChoice: false, choicePrompt: null, choices: [] }) : result;
      },
    };
    const runtime = new StoryRuntime(value.store, () => provider); const turn = await value.store.enqueueTurn(storyId, '沿当前阶段继续推进。', 'autoplay', 'stage-choice-0001'); await runtime.runTurn(turn.id);
    const waiting = await value.store.turn(turn.id); expect(waiting.status).toBe('waiting_player'); expect(waiting.steps.some(step => step.name === 'repairing')).toBe(false); expect(waiting.scene?.location).toBe(protagonist.location); expect(waiting.scene?.participants.every(id => originalLocations.get(id) === protagonist.location)).toBe(true);
    const beforeChoice = await value.store.state(storyId); expect(beforeChoice.characters.every(character => character.location === originalLocations.get(character.id))).toBe(true); expect(beforeChoice.facts.some(fact => fact.sourceTurnId === turn.id && fact.tags.includes('decision_point'))).toBe(true);
    await value.store.resolveChoice(storyId, '资料'); const finished = await value.store.turn(turn.id);
    expect(finished.status).toBe('completed'); const finalState = await value.store.state(storyId); expect(finalState.facts.at(-1)?.payload).toEqual({ type: 'player_choice', choice: '资料' });
  });

  it('records participant travel before committing a scene at a new location', async () => {
    const value = await fixture(); cleanups.push(value.close); const storyId = await createActiveStory(value, 'modern_mystery'); const base = deterministicProvider(storyDeterministicGenerator);
    const provider = {
      name: 'deterministic' as const,
      async run(role: string, prompt: string, schema: any, signal?: AbortSignal) {
        const result: any = await base.run(role, prompt, schema, signal);
        if (role !== 'Director Agent') return result;
        return schema.parse({ ...result, location: '社区中心验收办公室', changes: result.changes.filter((change: any) => change.field !== 'location') });
      },
    };
    const runtime = new StoryRuntime(value.store, () => provider); const turn = await value.store.enqueueTurn(storyId, '前往社区中心核验证据。', 'test', 'travel-normalization-0001'); await runtime.runTurn(turn.id);
    const finished = await value.store.turn(turn.id); const state = await value.store.state(storyId); expect(finished.status).toBe('completed');
    for (const participantId of finished.scene!.participants) expect(state.characters.find(character => character.id === participantId)?.location).toBe('社区中心验收办公室');
    expect(state.facts.filter(fact => fact.tags.includes('location')).length).toBeGreaterThanOrEqual(finished.scene!.participants.length);
  });

  it('turns a premature opening direction choice into a traceable first observation', async () => {
    const value = await fixture(); cleanups.push(value.close); const storyId = await createActiveStory(value, 'cultivation'); const initial = await value.store.state(storyId); await value.store.editStage(storyId, { ...initial.activeStage!, completionCriteria: [...initial.activeStage!.completionCriteria, '玩家决定第二日调查方向'] }); const base = deterministicProvider(storyDeterministicGenerator);
    const runtime = new StoryRuntime(value.store, () => ({ name: 'deterministic', async run(role: string, prompt: string, schema: any, signal?: AbortSignal) { const result: any = await base.run(role, prompt, schema, signal); return role === 'Director Agent' ? schema.parse({ ...result, requiresPlayerChoice: true, choicePrompt: '确定第二日方向。', choices: ['向北', '向南'] }) : result; } }));
    const turn = await value.store.enqueueTurn(storyId, '先核对眼前证据，再决定方向。', 'codex', 'opening-observation-0001'); await runtime.runTurn(turn.id); const finished = await value.store.turn(turn.id); const state = await value.store.state(storyId);
    expect(finished.status).toBe('completed'); expect(finished.waitingReason).toBeNull(); expect(state.facts.some(fact => fact.sourceTurnId === turn.id && fact.tags.includes('opening_observation'))).toBe(true);
  });

  it('forces a player decision when the opening stage entry criteria requires one', async () => {
    const value = await fixture(); cleanups.push(value.close); const storyId = await createActiveStory(value, 'modern_mystery'); const state = await value.store.state(storyId); await value.store.editStage(storyId, { ...state.activeStage!, entryCriteria: ['玩家决定先审查材料、访谈人员或查看系统日志'] });
    const turn = await value.store.enqueueTurn(storyId, '开始第一步调查。', 'codex', 'entry-choice-0001'); await value.runtime.runTurn(turn.id); const waiting = await value.store.turn(turn.id);
    expect(waiting.status).toBe('waiting_player'); expect(waiting.waitingReason).toContain('玩家决定'); expect(waiting.scene?.participants).toContain(state.characters.find(character => character.importance === 'protagonist')!.id);
  });

  it('turns an unsupported remote-evidence claim into a neutral local decision point', async () => {
    const value = await fixture(); cleanups.push(value.close); const storyId = await createActiveStory(value, 'modern_mystery'); const opening = await value.store.enqueueTurn(storyId, '先完成开局核验。', 'test', 'neutral-choice-opening'); await value.runtime.runTurn(opening.id); const state = await value.store.state(storyId); const protagonist = state.characters.find(character => character.importance === 'protagonist')!; const base = deterministicProvider(storyDeterministicGenerator);
    const runtime = new StoryRuntime(value.store, () => ({ name: 'deterministic', async run(role: string, prompt: string, schema: any, signal?: AbortSignal) {
      const result: any = await base.run(role, prompt, schema, signal); if (role !== 'Director Agent') return result;
      return schema.parse({ ...result, title: '旧案发生地的未归档照片', location: '尚未抵达的旧案现场', requiresPlayerChoice: true, choicePrompt: '已核实线索确认现场照片指向被封存的通信记录，接下来使用哪一项？', choices: ['公开已获得的照片', '使用已确认的旁证'] });
    } }));
    const turn = await value.store.enqueueTurn(storyId, '决定下一步调查方向。', 'test', 'neutral-choice-0001'); await runtime.runTurn(turn.id); const waiting = await value.store.turn(turn.id); const finalState = await value.store.state(storyId); const runtimeData = await value.store.runtimeData(turn.id); const plan = runtimeData.plan as any;
    expect(waiting.status).toBe('waiting_player'); expect(waiting.scene?.location).toBe(protagonist.location); expect(plan.title).toContain('行动前的分岔');
    const facts = finalState.facts.filter(fact => fact.sourceTurnId === turn.id); expect(JSON.stringify(facts)).not.toMatch(/已获得|已确认的旁证|已核实线索|旧案发生地的未归档照片/); expect(plan.choicePrompt).toBe('下一步先核验哪一项仍未确认的线索？'); expect(plan.choices).toEqual(['先核对现有资料', '先询问相关知情人', '先勘察可以安全到达的目标地点']);
  });

  it('records delegated reversible choices during autoplay without bypassing major-choice guards', async () => {
    const value = await fixture(); cleanups.push(value.close); const storyId = await createActiveStory(value, 'modern_mystery'); const opening = await value.store.enqueueTurn(storyId, '先完成一次普通开局核验。', 'test', 'delegation-opening-0001'); await value.runtime.runTurn(opening.id); const base = deterministicProvider(storyDeterministicGenerator);
    const runtime = new StoryRuntime(value.store, () => ({ name: 'deterministic', async run(role: string, prompt: string, schema: any, signal?: AbortSignal) {
      const result: any = await base.run(role, prompt, schema, signal);
      if (role === 'Director Agent') return schema.parse({ ...result, changes: [...result.changes, { type: 'fact', kind: 'dialogue', text: '场景末尾呈现调查方向，任何方向均在玩家选择前不执行。', tags: ['decision-point', 'awaiting-player'] }], requiresPlayerChoice: true, choicePrompt: '选择普通调查方向。', choices: ['先核对旁证', '先观察现场'] });
      if (role.startsWith('Character Agent') && prompt.includes('任何方向均在玩家选择前不执行') && prompt.includes('autoplay_delegated_choice')) return schema.parse({ approved: false, summary: '授权执行与等待选择冲突。', issues: [{ code: 'fact_contradiction', message: '同一可撤回方向同时声明执行和等待玩家，行动状态矛盾。', severity: 'blocking' }] });
      return result;
    } }));
    const session = await runtime.startAutoplay(storyId, { durationMinutes: 360, maxScenes: 2 }); expect((await value.store.context(storyId)).autoplay?.id).toBe(session.id); const queued = await value.database.pool.query("SELECT id FROM story_turns WHERE story_id=$1 AND idempotency_key=$2", [storyId, `autoplay:${session.id}:1`]); await runtime.runTurn(queued.rows[0].id); const finished = await value.store.turn(queued.rows[0].id); const facts = await value.database.pool.query('SELECT tags,payload FROM facts WHERE story_id=$1 ORDER BY seq', [storyId]);
    expect(finished.status).toBe('completed'); expect(facts.rows.some(row => row.payload?.type === 'autoplay_authorized')).toBe(true); expect(facts.rows.some(row => row.tags.includes('autoplay_delegated_choice'))).toBe(true); expect(facts.rows.some(row => row.tags.includes('awaiting-player') || row.tags.includes('awaiting_player'))).toBe(false);
  });

  it('does not delegate a choice that an explicit stage boundary reserves for the player', async () => {
    const value = await fixture(); cleanups.push(value.close); const storyId = await createActiveStory(value, 'science_fiction'); const opening = await value.store.enqueueTurn(storyId, '先完成开局核验。', 'test', 'boundary-opening-0001'); await value.runtime.runTurn(opening.id);
    const state = await value.store.state(storyId); await value.store.editStage(storyId, { ...state.activeStage!, boundaries: [...state.activeStage!.boundaries, '是否公开完整数据、保护特定人物或维持任务运行由玩家决定'] }); const base = deterministicProvider(storyDeterministicGenerator); let directorCalls = 0;
    const runtime = new StoryRuntime(value.store, () => ({ name: 'deterministic', async run(role: string, prompt: string, schema: any, signal?: AbortSignal) {
      const result: any = await base.run(role, prompt, schema, signal);
      if (role === 'Director Agent') { directorCalls += 1; return directorCalls === 1
        ? schema.parse({ ...result, objective: '暂缓正式验收并维持任务运行。', changes: [...result.changes, { type: 'fact', kind: 'action', text: '本场维持任务运行并继续收集证据。', tags: ['mission-running'] }], requiresPlayerChoice: false, choicePrompt: null, choices: [] })
        : schema.parse({ ...result, requiresPlayerChoice: true, choicePrompt: '是否维持任务运行？', choices: ['暂缓验收并维持任务运行', '结束任务并提交现有证据'] }); }
      if (prompt.includes('维持任务运行') && prompt.includes('"requiresPlayerChoice":false')) return schema.parse({ approved: false, summary: '阶段边界要求玩家决定。', issues: [{ code: 'stage_boundary', message: '维持任务运行由玩家决定，当前计划不得直接执行。', severity: 'blocking' }] });
      return result;
    } }));
    const session = await runtime.startAutoplay(storyId, { durationMinutes: 360, maxScenes: 2 }); const queued = await value.database.pool.query("SELECT id FROM story_turns WHERE story_id=$1 AND idempotency_key=$2", [storyId, `autoplay:${session.id}:1`]); await runtime.runTurn(queued.rows[0].id); const waiting = await value.store.turn(queued.rows[0].id); const facts = await value.database.pool.query('SELECT tags FROM facts WHERE source_turn_id=$1 ORDER BY seq', [queued.rows[0].id]);
    expect(waiting.status).toBe('waiting_player'); expect(waiting.waitingReason).toContain('维持任务运行'); expect(waiting.steps.some(step => step.name === 'repairing')).toBe(true); expect(facts.rows.some(row => row.tags.includes('decision_point'))).toBe(true); expect(facts.rows.some(row => row.tags.includes('autoplay_delegated_choice'))).toBe(false);
  });

  it('forces a decision point when autoplay reaches a dated stage boundary reserved for the player', async () => {
    const value = await fixture(); cleanups.push(value.close); const storyId = await createActiveStory(value, 'modern_mystery');
    for (let index = 0; index < 3; index++) { const turn = await value.store.enqueueTurn(storyId, `推进到首日边界前 ${index}`, 'test', `deadline-setup-${index}`); await value.runtime.runTurn(turn.id); }
    const state = await value.store.state(storyId); await value.store.editStage(storyId, { ...state.activeStage!, objective: `在故事首日完成：${state.activeStage!.objective}`, boundaries: [...state.activeStage!.boundaries, '第一阶段结束时，是否公开已核实线索或继续保密由玩家决定'] });
    const session = await value.runtime.startAutoplay(storyId, { durationMinutes: 360, maxScenes: 2 }); const queued = await value.database.pool.query("SELECT id FROM story_turns WHERE story_id=$1 AND idempotency_key=$2", [storyId, `autoplay:${session.id}:1`]); await value.runtime.runTurn(queued.rows[0].id); const waiting = await value.store.turn(queued.rows[0].id);
    expect(waiting.status).toBe('waiting_player'); expect(waiting.scene?.endTime).toBe(1440); expect(waiting.waitingReason).toContain('公开已核实线索');
  });

  it('caps progress at 99 when a stage completion review says evidence is still missing', async () => {
    const value = await fixture(); cleanups.push(value.close); const storyId = await createActiveStory(value, 'modern_mystery'); const state = await value.store.state(storyId); await value.store.editStage(storyId, { ...state.activeStage!, progress: 95 });
    const base = deterministicProvider(storyDeterministicGenerator); const provider = { name: 'deterministic' as const, async run(role: string, prompt: string, schema: any, signal?: AbortSignal) {
      const result: any = await base.run(role, prompt, schema, signal);
      if (role === 'Stage Agent' && /"stageProgressDelta":(?:[5-9]|[1-9]\d)/.test(prompt)) return schema.parse({ approved: false, summary: '完成条件证据不足。', issues: [{ code: 'stage_boundary', message: '计划会把阶段推进至100%，但尚未确认完成条件，与当前阶段结算要求冲突。', severity: 'blocking' }] });
      return result;
    } };
    const runtime = new StoryRuntime(value.store, () => provider); const turn = await value.store.enqueueTurn(storyId, '继续核验，但不要提前结算阶段。', 'test', 'stage-cap-0001'); await runtime.runTurn(turn.id);
    const finished = await value.store.turn(turn.id); const finalState = await value.store.state(storyId);
    expect(finished.status).not.toBe('failed'); expect(finished.steps.some(step => step.name === 'repairing')).toBe(true); expect(finalState.activeStage?.progress).toBe(99);
  });
});
