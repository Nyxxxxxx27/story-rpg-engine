import { CURRENT_SCHEMA_VERSION } from '../packages/storage/experience-store.ts';
import { afterEach, describe, expect, it } from 'vitest';
import { readdir } from 'node:fs/promises';
import { characterSchema, scenePlanSchema, narrationSchema } from '../packages/contracts/index.ts';
import { validateProsePolish, checkNarrationFacts } from '../packages/agent-runtime/public-narration.ts';
import { layeredPrompt } from '../packages/agent-runtime/prompts.ts';
import { StoryRuntime } from '../packages/agent-runtime/runtime.ts';
import { StoryStore } from '../packages/storage/store.ts';
import { deterministicProvider } from '../packages/agent-runtime/provider.ts';
import { storyDeterministicGenerator } from '../packages/agent-runtime/deterministic.ts';
import { createActiveStory, fixture } from './helpers.ts';
const cleanups: Array<() => Promise<void>> = []; afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });
const chars = ['沈砚', '顾清漪'].map((name, index) => characterSchema.parse({ id: `person-${index}`, name, importance: index ? 'core' : 'protagonist', publicProfile: '同行者', location: '城门' }));
const plan = scenePlanSchema.parse({ title: '城门', objective: '讨论', location: '城门', participants: chars.map(c => c.id), durationMinutes: 10, beats: ['讨论'], changes: [{ type: 'fact', kind: 'dialogue', text: '两人交谈。', tags: ['talk'] }], requiresPlayerChoice: false, choicePrompt: null, choices: ['继续交谈'], checkTags: [] });

describe('narration integrity and save migration', () => {
  it.each([
    ['沈砚没有杀死守卫。', '沈砚杀死守卫。'],
    ['沈砚未杀死守卫。', '沈砚杀死守卫。'],
    ['沈砚把信物交给顾清漪。', '顾清漪把信物交给沈砚。'],
    ['沈砚持有两枚信物。', '沈砚持有三枚信物。'],
    ['信物属于沈砚，顾清漪在旁。', '信物属于顾清漪，沈砚在旁。'],
    ['沈砚怀疑旧门后藏着信物。', '沈砚确认旧门后藏着信物。'],
  ])('rejects factual polish drift: %s', (original, candidate) => {
    expect(validateProsePolish(original, candidate, plan, chars).applied).toBe(false);
  });

  it('flags future choice execution and unsupported numbers in the initial prose', () => {
    const narration = narrationSchema.parse({ title: '城门', prose: '沈砚已经执行计划，拿出10枚信物。', summary: '行动完成。', choices: [] });
    const issues = checkNarrationFacts(narration, { ...plan, requiresPlayerChoice: true }, chars, []);
    expect(issues.some(issue => issue.includes('数字'))).toBe(true); expect(issues.some(issue => issue.includes('提前执行'))).toBe(true);
  });

  it('gives narrator only committed public data and polish only its draft', async () => {
    const value = await fixture(); cleanups.push(value.close); const storyId = await createActiveStory(value);
    const context = await value.store.context(storyId); const secret = context.characters[1].privateProfile;
    const narrator = layeredPrompt('Narrator Agent', { ...context, fullCharacterIds: context.characters.map(c => c.id), committedFacts: [] }, '写正文', narrationSchema);
    expect(narrator).not.toContain(secret); expect(narrator).not.toContain('<current_stage>'); expect(narrator).not.toContain(context.arc.stakes);
    const polish = layeredPrompt('Polish Agent', { ...context, draftNarration: { title: '标题', prose: '雨落下来。', summary: '下雨。', choices: [] } }, '润色', narrationSchema);
    expect(polish).not.toContain(secret); expect(polish).not.toContain(context.config.premise); expect(polish).not.toContain('<character_profiles>');
  });

  it('falls back after one failed repair, hides unverified prose and retries narration without new actions', async () => {
    const value = await fixture(); cleanups.push(value.close); const storyId = await createActiveStory(value); const base = deterministicProvider(storyDeterministicGenerator);
    let bad = true, repairs = 0; const publishedDrafts: string[] = [];
    const runtime = new StoryRuntime(value.store, () => ({ name: 'deterministic', async run(role, prompt, schema, signal) {
      if (role === 'Stage Agent') { const result: any = await base.run(role, prompt, schema, signal); return schema.parse({ ...result, milestones: [] }); }
      if (role === 'Narrator Agent' && bad) { if (prompt.includes('修订一次正文')) repairs++; const state = await value.store.state(storyId); publishedDrafts.push(JSON.stringify(state)); return schema.parse({ title: '错误草稿', prose: '主角获得999枚信物并杀死守卫。', summary: '999枚信物已经到手。', choices: ['继续核对记录'] }); }
      if (role === 'Narration Verifier') return schema.parse({ draftApproved: !bad, candidateApproved: !bad, issues: bad ? ['凭空获得物品和改变人物生死'] : [] });
      return base.run(role, prompt, schema, signal);
    } }));
    const turn = await value.store.enqueueTurn(storyId, '普通核对', 'test', 'fallback-test-001'); await runtime.runTurn(turn.id);
    let state = await value.store.state(storyId); expect(state.scenes[0].validation?.mode).toBe('fallback'); expect(repairs).toBe(1);
    expect(publishedDrafts.every(value => !value.includes('错误草稿') && !value.includes('999枚'))).toBe(true);
    const before = await value.store.stateHashes(storyId); const factCount = (await value.database.pool.query('SELECT count(*)::int AS count FROM facts WHERE story_id=$1', [storyId])).rows[0].count;
    bad = false; await value.store.retrySceneNarration(storyId, state.scenes[0].id, 'narration-retry-001'); await runtime.runTurn(turn.id);
    state = await value.store.state(storyId); expect(state.scenes).toHaveLength(1); expect(state.scenes[0].validation?.mode).toBe('rules');
    expect((await value.store.stateHashes(storyId)).stateHash).toBe(before.stateHash);
    expect((await value.database.pool.query('SELECT count(*)::int AS count FROM facts WHERE story_id=$1', [storyId])).rows[0].count).toBe(factCount);
    expect((await value.database.pool.query('SELECT * FROM narration_attempts WHERE turn_id=$1', [turn.id])).rows.length).toBeGreaterThan(2);
  });

  it('backs up and migrates multiple legacy saves once without inventing milestone completion', async () => {
    const value = await fixture(); cleanups.push(value.close);
    const ids = [await createActiveStory(value), await createActiveStory(value)];
    for (const id of ids) {
      const state = await value.store.state(id); const stage: any = { ...state.activeStage!, progress: 75 };
      for (const field of ['milestones', 'deadlineMinutes', 'outcome', 'awaitingDeadline', 'legacyProgress']) delete stage[field];
      await value.database.pool.query('UPDATE story_stages SET data=$2 WHERE id=$1', [stage.id, stage]);
      await value.database.pool.query('UPDATE stories SET schema_version=1 WHERE id=$1', [id]);
    }
    const store = new StoryStore(value.database); await store.setup(); await store.setup();
    for (const id of ids) {
      const state = await store.state(id); expect(state.schemaVersion).toBe(CURRENT_SCHEMA_VERSION); expect(state.activeStage!.progress).toBe(0); expect(state.activeStage!.legacyProgress).toBe(75); expect(state.activeStage!.milestones.every(item => item.status === 'pending')).toBe(true);
      const migrations = await value.database.pool.query("SELECT id FROM facts WHERE story_id=$1 AND payload->>'type'='save_migrated'", [id]); expect(migrations.rows).toHaveLength(1);
      expect((await store.stateHashes(id)).matches).toBe(true);
    }
    expect((await readdir(value.database.backupDirectory)).filter(name => name.endsWith('.json'))).toHaveLength(2*(CURRENT_SCHEMA_VERSION-1));
    expect((await value.database.pool.query('SELECT * FROM story_save_backups')).rows).toHaveLength(2);
  });

  it('keeps a semantically approved draft when only the polish fails', async () => {
    const value = await fixture(); cleanups.push(value.close); const storyId = await createActiveStory(value); const base = deterministicProvider(storyDeterministicGenerator);
    let draft = ''; const state = await value.store.state(storyId); await value.store.editStage(storyId, { ...state.activeStage!, entryCriteria: ['玩家选择路线'] });
    const runtime = new StoryRuntime(value.store, () => ({ name: 'deterministic', async run(role, prompt, schema, signal) {
      if (role === 'Polish Agent') return schema.parse({ prose: `${draft}\n灯光平静。` });
      if (role === 'Narration Verifier') return schema.parse({ draftApproved: true, candidateApproved: false, issues: ['润色引入未经确认的描写'] });
      const result = await base.run(role, prompt, schema, signal); if (role === 'Narrator Agent') draft = (result as any).prose; return result;
    } }));
    const turn = await value.store.enqueueTurn(storyId, '讨论路线', 'test', 'polish-fallback-001'); await runtime.runTurn(turn.id);
    const result = await value.store.turn(turn.id); expect(result.scene?.prose).toBe(draft); expect(result.scene?.validation?.mode).toBe('semantic'); expect(result.scene?.validation?.semanticCalls).toBe(1); expect(result.scene?.validation?.repairs).toBe(0);
  });

  it('repairs a contradicted first draft once and publishes only the approved revision', async () => {
    const value = await fixture(); cleanups.push(value.close); const storyId = await createActiveStory(value); const base = deterministicProvider(storyDeterministicGenerator); let repaired = false;
    const runtime = new StoryRuntime(value.store, () => ({ name: 'deterministic', async run(role, prompt, schema, signal) {
      if (role === 'Narrator Agent') {
        if (prompt.includes('修订一次正文')) repaired = true;
        if (!repaired) return schema.parse({ title: '核对记录', prose: '众人已经获得999枚信物。', summary: '999枚信物到手。', choices: ['继续核对记录'] });
      }
      if (role === 'Narration Verifier') return schema.parse({ draftApproved: repaired, candidateApproved: repaired, issues: repaired ? [] : ['新增未提交的物品'] });
      return base.run(role, prompt, schema, signal);
    } }));
    const turn = await value.store.enqueueTurn(storyId, '核对记录', 'test', 'repair-accepted-001'); await runtime.runTurn(turn.id);
    const result = await value.store.turn(turn.id); expect(result.scene?.prose).not.toContain('999'); expect(result.scene?.validation?.mode).toBe('semantic'); expect(result.scene?.validation?.repairs).toBe(1); expect(result.scene?.validation?.semanticCalls).toBe(2);
    expect((await value.store.stateHashes(storyId)).matches).toBe(true);
  });

  it('migrates old waiting choices while preserving historical completed stages and prose', async () => {
    const value = await fixture(); cleanups.push(value.close);
    const completedId = await createActiveStory(value);
    for (let index = 0; index < 2; index++) { const turn = await value.store.enqueueTurn(completedId, '核对记录', 'test', `legacy-complete-${index}`); await value.runtime.runTurn(turn.id); }
    const completed = await value.store.state(completedId);
    const waitingId = await createActiveStory(value); const before = await value.store.state(waitingId);
    await value.store.editStage(waitingId, { ...before.activeStage!, entryCriteria: ['玩家选择路线'] });
    const turn = await value.store.enqueueTurn(waitingId, '讨论路线', 'test', 'legacy-waiting-001'); await value.runtime.runTurn(turn.id);
    const waiting = await value.store.state(waitingId);
    await value.database.pool.query('DELETE FROM story_decisions WHERE story_id=$1', [waitingId]);
    await value.database.pool.query("UPDATE scenes SET data=data-'decisionId'-'options'-'validation' WHERE story_id=$1", [waitingId]);
    await value.database.pool.query('UPDATE stories SET schema_version=1 WHERE id=ANY($1::uuid[])', [[waitingId, completedId]]);
    await value.store.setup(); await value.store.setup();
    const migrated = await value.store.state(waitingId); expect(migrated.pendingDecision).not.toBeNull(); expect(migrated.scenes[0].prose).toBe(waiting.scenes[0].prose);
    expect((await value.store.state(completedId)).activeStage!.outcome).toBe('success'); expect((await value.store.state(completedId)).scenes.map(scene => scene.prose)).toEqual(completed.scenes.map(scene => scene.prose));
    expect((await value.database.pool.query("SELECT id FROM story_turns WHERE status='queued'" )).rows).toHaveLength(0);
    const resolution = await value.store.resolveChoice(waitingId, { decisionId: migrated.pendingDecision!.id, choice: '核对公共记录', source: 'test' }); await value.runtime.runTurn(resolution.continuationTurnId);
    expect((await value.store.state(waitingId)).scenes).toHaveLength(2); expect((await value.store.stateHashes(waitingId)).matches).toBe(true); expect((await value.store.stateHashes(completedId)).matches).toBe(true);
  });
});
