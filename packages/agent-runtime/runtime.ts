import { randomUUID } from 'node:crypto';
import { outlineDraftSchema, reviewSchema, scenePlanSchema, narrationSchema, autoplayRequestSchema, type AgentReview, type ScenePlan, type StoryStage, type StoryWorldConfig } from '../contracts/index.ts';
import { packsFor } from '../content/packs.ts';
import type { StoryStore } from '../storage/store.ts';
import { layeredPrompt, outlinePrompt } from './prompts.ts';
import type { StructuredAgentProvider } from './provider.ts';

export type ProviderResolver = (config: StoryWorldConfig) => StructuredAgentProvider;

export function stageTimeBoundary(stage: StoryStage | null) {
  if (!stage) return null; const title = stage.title; const constraints = [stage.objective, ...stage.completionCriteria].join('\n');
  if (/首日|第一日|第一天/.test(title)) return 1440;
  if (/第二日|第二天|第二夜/.test(title)) return 2880;
  if (/第三日|第三天|第三夜/.test(title)) return 4320;
  if (/(首日|第一日|第一天)(?:内|结束前|结束时|截止)/.test(constraints)) return 1440;
  if (/(第二日|第二天|第二夜)(?:内|结束前|结束时|截止)/.test(constraints)) return 2880;
  if (/(第三日|第三天|第三夜)(?:内|结束前|结束时|截止)/.test(constraints)) return 4320;
  if (/在(?:故事)?(?:首日|第一日|第一天)(?:内|结束前|结束时|截止)?(?:确认|完成|取得|推进|建立|查明|锁定|达成)/.test(constraints)) return 1440;
  if (/在(?:故事)?(?:第二日|第二天|第二夜)(?:内|结束前|结束时|截止)?(?:确认|完成|取得|推进|建立|查明|锁定|达成)/.test(constraints)) return 2880;
  if (/在(?:故事)?(?:第三日|第三天|第三夜)(?:内|结束前|结束时|截止)?(?:确认|完成|取得|推进|建立|查明|锁定|达成)/.test(constraints)) return 4320;
  return null;
}

async function parallelLimit<T, R>(items: T[], limit: number, operation: (item: T, index: number) => Promise<R>) {
  const results = new Array<R>(items.length); let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) { const index = cursor++; results[index] = await operation(items[index], index); }
  });
  await Promise.all(workers); return results;
}

export class StoryRuntime {
  private stopped = false;
  private outboxTimer?: NodeJS.Timeout;
  private workId?: string;
  private readonly activeRuns = new Map<string, AbortController>();
  private outboxFlush: Promise<void> = Promise.resolve();

  constructor(readonly store: StoryStore, private readonly resolveProvider: ProviderResolver) {}

  async generateOutline(storyId: string, owner?: string) {
    const { config, seed } = await this.store.config(storyId, owner); const provider = this.resolveProvider(config);
    const draft = await provider.run('Outline Agent', outlinePrompt(config, seed, outlineDraftSchema), outlineDraftSchema);
    return this.store.saveOutline(storyId, owner, draft);
  }

  async start() {
    this.stopped = false; await this.store.recoverInterrupted(); await this.store.flushOutbox();
    this.workId = await this.store.database.boss.work('story-turn', { batchSize: 1, pollingIntervalSeconds: 1 }, async jobs => {
      for (const job of jobs) await this.runTurn((job.data as { turnId: string }).turnId);
    });
    this.outboxTimer = setInterval(() => { this.outboxFlush = this.store.flushOutbox().catch(error => console.error('Outbox:', error)); }, 500);
  }

  async stop() {
    this.stopped = true;
    if (this.outboxTimer) clearInterval(this.outboxTimer);
    for (const controller of this.activeRuns.values()) controller.abort(new Error('Worker is restarting'));
    let outboxStopped = false; await Promise.race([this.outboxFlush.then(() => { outboxStopped = true; }), new Promise<void>(resolveWait => setTimeout(resolveWait, 5000))]);
    if (!outboxStopped) console.warn('Story outbox flush exceeded 5 seconds; shutdown will recover undispatched rows on restart.');
    const deadline = Date.now() + 5000;
    while (this.activeRuns.size && Date.now() < deadline) await new Promise(resolveWait => setTimeout(resolveWait, 20));
    if (this.workId) {
      let workerStopped = false;
      await Promise.race([
        this.store.database.boss.offWork('story-turn', { id: this.workId, wait: true }).then(() => { workerStopped = true; }),
        new Promise<void>(resolveWait => setTimeout(resolveWait, 5000)),
      ]);
      if (!workerStopped) console.warn('Story worker cleanup exceeded 5 seconds; database shutdown will abort remaining queue work.');
    }
  }

  private async step<T>(turnId: string, name: string, role: string, operation: () => Promise<T>, summary: (result: T) => string) {
    const id = await this.store.startStep(turnId, name, role);
    try { const result = await operation(); await this.store.finishStep(id, summary(result)); return result; }
    catch (error) {
      const interrupted = this.stopped && this.activeRuns.get(turnId)?.signal.aborted;
      await this.store.finishStep(id, interrupted ? '运行被服务重启中断；本步骤未提交状态，将从持久化节点恢复。' : error instanceof Error ? error.message : String(error), !interrupted);
      throw error;
    }
  }

  private validatePlan(plan: ScenePlan, context: Awaited<ReturnType<StoryStore['context']>>) {
    const issues: AgentReview['issues'] = [];
    const ids = new Set(context.characters.map(character => character.id));
    for (const id of plan.participants) if (!ids.has(id)) issues.push({ code: 'unknown_character', message: `参与者 ${id} 不存在。`, severity: 'blocking' });
    if (!plan.participants.some(id => context.characters.find(character => character.id === id)?.importance === 'protagonist')) issues.push({ code: 'missing_protagonist', message: '每个玩家回合必须包含主角。', severity: 'blocking' });
    for (const change of plan.changes) if (change.type === 'character' && !ids.has(change.characterId)) issues.push({ code: 'unknown_change_target', message: `状态变更角色 ${change.characterId} 不存在。`, severity: 'blocking' });
    for (const participantId of plan.participants) {
      const character = context.characters.find(item => item.id === participantId);
      const arrives = plan.changes.some(change => change.type === 'character' && change.characterId === participantId && change.field === 'location' && change.value === plan.location);
      if (character && character.location !== plan.location && !arrives) issues.push({ code: 'location_contradiction', message: `${character.name} 未从“${character.location}”移动到场景地点“${plan.location}”。`, severity: 'blocking' });
    }
    return issues;
  }

  private normalizeReview(review: AgentReview): AgentReview {
    const blockingCodes = new Set(['fact_contradiction', 'time_contradiction', 'location_contradiction', 'agency_violation', 'major_choice_violation', 'permanent_change', 'stage_boundary', 'genre_leak', 'world_rule_violation', 'impossible_action', 'pack_rule']);
    const issues = review.issues.map(issue => {
      const missingPriorSupport = /(没有|尚无|缺少).{0,30}(已提交|既有|最近场景|相关事实|历史|记录|依据|支持)/.test(issue.message) || /(历史|记录).{0,20}(没有|尚无|缺少)/.test(issue.message) || /(未确认|未记录|未证明|未表明)/.test(issue.message);
      const treatsPlannedChangeAsTooEarly = /(尚未|还未|未曾).{0,24}(执行|发生|完成|提交|核对|产生)/.test(issue.message);
      const namesActualConflict = /(冲突|矛盾|不一致|违背)/.test(issue.message);
      const describesCurrentCandidate = /(计划|候选|changes|变更|本场行动|本场观察|本场台词|本场.{0,12}产生)/i.test(issue.message);
      const treatsCandidateAsPriorFact = (missingPriorSupport || treatsPlannedChangeAsTooEarly) && describesCurrentCandidate && !namesActualConflict;
      return issue.severity === 'blocking' && (!blockingCodes.has(issue.code) || treatsCandidateAsPriorFact) ? { ...issue, severity: 'warning' as const } : issue;
    });
    return reviewSchema.parse({ ...review, approved: !issues.some(issue => issue.severity === 'blocking'), issues });
  }

  private normalizePlan(plan: ScenePlan, context: Awaited<ReturnType<StoryStore['context']>>, routineChoicesDelegated = false) {
    const stripModelTiming = (beat: string) => beat
      .replace(/(?:第|前|后)?\s*\d+\s*(?:至|到|—|-|~)\s*\d+\s*分钟(?:内|后|时)?/g, '本场')
      .replace(/(?:第|前|后)?\s*\d+\s*分钟(?:内|后|时)?/g, '本场')
      .replace(/时间\s*\d+/g, '本场末段');
    plan = scenePlanSchema.parse({ ...plan, beats: plan.beats.map(stripModelTiming) });
    const explicitMajor = plan.changes.some(change => 'significance' in change && change.significance === 'major');
    const majorTag = plan.checkTags.some(tag => ['death', 'permanent_exit', 'irreversible', 'major_relationship', 'critical_choice'].includes(tag));
    const majorLanguage = /死亡|牺牲|永久离场|不可逆|决裂|终身|处决|death|permanent|irreversible/i.test(JSON.stringify({ objective: plan.objective, choicePrompt: plan.choicePrompt, beats: plan.beats, changes: plan.changes }));
    const choicePattern = /玩家.{0,20}(选择|决定)|由玩家.{0,20}(选择|决定)/;
    const explicitBoundaryChoice = /(?:由|交由|留给)玩家.{0,8}(?:选择|决定)|(?:必须|需要|应当).{0,16}(?:等待|交由|留给).{0,8}玩家.{0,8}(?:选择|决定)|必须等待玩家.{0,8}(?:选择|决定)/;
    const stageNamesChoice = choicePattern.test(JSON.stringify(context.stage?.completionCriteria ?? []));
    const stageEntryRequiresChoice = context.scenes.length === 0 && choicePattern.test(JSON.stringify(context.stage?.entryCriteria ?? []));
    const stageBoundaryText = JSON.stringify(context.stage?.boundaries ?? []); const deadline = stageTimeBoundary(context.stage); const reachesDeadline = deadline !== null && context.clock < deadline && context.clock + plan.durationMinutes >= deadline;
    const deadlineBoundaryRequiresChoice = reachesDeadline && /是否.{0,100}(?:由|交由|留给)玩家.{0,8}(?:选择|决定)/.test(stageBoundaryText);
    const stageBoundaryRequiresChoice = deadlineBoundaryRequiresChoice || (plan.requiresPlayerChoice && explicitBoundaryChoice.test(stageBoundaryText));
    const lastProgress = context.facts.findLastIndex(fact => fact.payload?.type === 'stage_progress' && fact.payload.stageId === context.stage?.id);
    const choiceAfterProgress = context.facts.slice(lastProgress + 1).some(fact => fact.payload?.type === 'player_choice');
    const engineMajorRequiresChoice = explicitMajor || majorTag || majorLanguage;
    const stageRequiresChoice = engineMajorRequiresChoice || stageEntryRequiresChoice || stageBoundaryRequiresChoice || (stageNamesChoice && (context.stage?.progress ?? 0) + plan.stageProgressDelta >= 100 && !choiceAfterProgress);
    if (stageRequiresChoice && !plan.requiresPlayerChoice) {
      const criteria = engineMajorRequiresChoice ? ['重大或不可逆变化必须由玩家确认'] : stageEntryRequiresChoice ? context.stage?.entryCriteria ?? [] : stageBoundaryRequiresChoice ? context.stage?.boundaries ?? [] : context.stage?.completionCriteria ?? [];
      plan = scenePlanSchema.parse({ ...plan, requiresPlayerChoice: true, choicePrompt: `当前阶段需要玩家决定：${criteria.join('；')}`, choices: plan.choices.length ? plan.choices : criteria.slice(0, 5) });
    }
    const presenceTags = (participants: string[]) => plan.checkTags.filter(tag => {
      if (tag === 'heroine_present') return participants.some(id => context.characters.find(character => character.id === id)?.roleTags.includes('heroine'));
      if (tag === 'love_interest_present') return participants.some(id => context.characters.find(character => character.id === id)?.roleTags.includes('love_interest'));
      return true;
    });
    const openingRoutineDecision = context.scenes.length === 0 && plan.requiresPlayerChoice && !explicitMajor && !majorTag && !majorLanguage && !stageRequiresChoice;
    if (openingRoutineDecision) {
      const protagonist = context.characters.find(character => character.importance === 'protagonist')!; const participants = plan.participants.filter(id => context.characters.find(character => character.id === id)?.location === protagonist.location);
      if (!participants.includes(protagonist.id)) participants.unshift(protagonist.id);
      return scenePlanSchema.parse({
        ...plan, objective: '在当前地点完成首次无损初步核验，记录可复查观察，不预先确定后续调查方向或任何人的责任。', location: protagonist.location, participants,
        beats: ['参与者以观察、询问或只读方式完成首次初步核验。', '把本场可直接确认的观察记录为待复查线索。', '保留后续方向，不在本场作出长期或不可逆决定。'],
        changes: [{ type: 'fact', kind: 'action', text: `参与者在${protagonist.location}完成了首次无损初步核验，留下待复查观察；尚未确定后续调查方向或责任。`, tags: ['opening_observation', 'needs_verification'] }],
        stageProgressDelta: Math.max(10, Math.min(plan.stageProgressDelta, 20)), requiresPlayerChoice: false, choicePrompt: null, choices: [], checkTags: presenceTags(participants),
      });
    }
    if (routineChoicesDelegated && plan.requiresPlayerChoice && !explicitMajor && !majorTag && !majorLanguage && !stageRequiresChoice) {
      const delegatedChoice = plan.choices.find(choice => /保守|核对|观察|暂缓|旁证|记录|复查|可撤回/.test(choice)) ?? plan.choices[0] ?? '仅执行可撤回的现场核验';
      const authorization = { type: 'fact' as const, kind: 'action' as const, text: `依据玩家的托管授权，本场选择可撤回方向：“${delegatedChoice}”；该选择不构成重大或不可逆决定。`, tags: ['autoplay_delegated_choice', 'reversible'] };
      const delegatedChanges = plan.changes.filter(change => change.type !== 'fact' || (
        !change.tags.some(tag => ['decision_point', 'decision-point', 'awaiting_player', 'awaiting-player'].includes(tag))
        && !/(等待玩家|玩家选择前|尚待玩家|任何(?:选项|方向).{0,20}(?:未执行|不执行))/.test(change.text)
      ));
      const delegatedBeats = plan.beats
        .filter(beat => !/(等待玩家|玩家选择前|尚待玩家|呈现.{0,12}(?:选项|方向))/.test(beat))
        .map(beat => /选择|决定|三条|路径|方向/.test(beat) ? `依据托管授权选择并执行可撤回方向：“${delegatedChoice}”。` : beat);
      plan = scenePlanSchema.parse({
        ...plan, objective: `在玩家托管授权范围内执行可撤回方向：“${delegatedChoice}”，同时保留重大方向的玩家决定权。`,
        beats: delegatedBeats.length ? delegatedBeats : [`依据托管授权执行可撤回方向：“${delegatedChoice}”。`],
        changes: [...delegatedChanges.slice(0, 15), authorization], requiresPlayerChoice: false, choicePrompt: null, choices: [],
      });
    }
    const protagonist = context.characters.find(character => character.importance === 'protagonist')!;
    if (plan.requiresPlayerChoice) {
      const participants = plan.participants.filter(id => context.characters.find(character => character.id === id)?.location === protagonist.location);
      if (!participants.includes(protagonist.id)) participants.unshift(protagonist.id);
      const decision = (plan.choicePrompt ?? plan.choices.join('、') ?? '后续方向').slice(0, 600);
      return scenePlanSchema.parse({
        ...plan, objective: '在当前地点进行现场观察或交谈，形成可追溯的决定点，并停在玩家选择执行之前。', location: protagonist.location, participants,
        beats: ['参与者在本场观察现场，并陈述各自可以直接确认的信息。', '参与者基于本场观察说明可选方向及各自风险。', '在执行任何选项前停下，等待玩家决定。'],
        changes: [{ type: 'fact', kind: 'dialogue', text: `在${protagonist.location}，参与者向玩家呈现了待决定事项：“${decision}”；任何选项及其后果均未执行。`, tags: ['decision_point', 'awaiting_player'] }],
        stageProgressDelta: Math.min(plan.stageProgressDelta, 5), checkTags: presenceTags(participants),
      });
    }
    const supported = plan.changes.filter(change => change.type === 'fact' || change.type === 'character' ? change.type === 'fact' || plan.participants.includes(change.characterId) : plan.participants.includes(change.from) && plan.participants.includes(change.to));
    const nonLocation = supported.filter(change => change.type !== 'character' || change.field !== 'location'); const movements = [] as ScenePlan['changes'];
    for (const participantId of plan.participants) {
      const character = context.characters.find(item => item.id === participantId); if (!character || character.location === plan.location) continue;
      const existing = supported.find(change => change.type === 'character' && change.characterId === participantId && change.field === 'location');
      movements.push({ type: 'character', characterId: participantId, field: 'location', value: plan.location, significance: existing && 'significance' in existing ? existing.significance : 'minor' });
    }
    const capacity = Math.max(0, 16 - movements.length); const changes = [...nonLocation.slice(0, capacity), ...movements];
    if (!changes.length) changes.push({ type: 'fact', kind: 'action', text: `参与者在${plan.location}完成了本场行动。`, tags: ['scene_action'] });
    const travelBeat = movements.length ? [`实际到场者从各自当前位置抵达${plan.location}，移动逐人记录为状态事件。`] : [];
    return scenePlanSchema.parse({ ...plan, changes, beats: [...travelBeat, ...plan.beats].slice(0, 8), checkTags: presenceTags(plan.participants) });
  }

  private async reviews(turnId: string, provider: StructuredAgentProvider, context: Awaited<ReturnType<StoryStore['context']>>, plan: ScenePlan, signal?: AbortSignal) {
    type ReviewTask = { name: string; role: string; task: string; deterministicIssues?: AgentReview['issues'] };
    const participants = context.characters.filter(character => plan.participants.includes(character.id));
    const tasks: ReviewTask[] = [
      { name: 'continuity', role: 'Continuity Agent', task: `检查场景计划的时间、地点、事实连续性。计划：${JSON.stringify(plan)}` },
      { name: 'stage', role: 'Stage Agent', task: `检查计划是否推进长期目标与当前阶段，并指出无依据的偏离。计划：${JSON.stringify(plan)}` },
      { name: 'agency', role: 'Protagonist Agency Agent', task: `检查计划是否替玩家作出重大、不可逆的主角决定。计划：${JSON.stringify(plan)}` },
      ...participants.filter(character => ['protagonist', 'core'].includes(character.importance)).map(character => ({ name: 'character', role: `Character Agent · ${character.name}`, task: `以角色 ${character.id} 的实时档案检查行为、动机、关系和台词空间是否一致。不要创作正文。计划：${JSON.stringify(plan)}` })),
      ...packsFor(context.config).map(pack => ({ name: 'pack', role: `Rules Agent · ${pack.title}`, task: `依据故事包规则检查行动结果。计划：${JSON.stringify(plan)}`, deterministicIssues: pack.validate(plan, { config: context.config, knownLocations: new Set(context.characters.map(character => character.location)) }).map(message => ({ code: 'pack_rule', message, severity: 'blocking' as const })) })),
    ];
    const results = await parallelLimit(tasks, provider.name === 'codex' ? 2 : 4, async task => this.step(turnId, task.name, task.role, async () => {
      const review = this.normalizeReview(await provider.run(task.role, layeredPrompt(task.role, { ...context, fullCharacterIds: plan.participants }, `${task.task}\n只有以下代码可标记 blocking：fact_contradiction、time_contradiction、location_contradiction、agency_violation、major_choice_violation、permanent_change、stage_boundary、genre_leak、world_rule_violation、impossible_action、pack_rule。候选场景中尚未发生但会由本场行动、观察或台词支持的细节不是既成事实，最多给 warning。其他改进建议必须标记 warning。`, reviewSchema), reviewSchema, signal));
      if (task.deterministicIssues?.length) return { approved: false, summary: task.deterministicIssues.map(issue => issue.message).join('；'), issues: [...review.issues, ...task.deterministicIssues] };
      return review;
    }, result => result.summary));
    const engineIssues = this.validatePlan(plan, context);
    if (engineIssues.length) results.push({ approved: false, summary: '确定性提交校验失败。', issues: engineIssues });
    return results;
  }

  private async resumeAfterCommit(turnId: string, storyId: string, provider: StructuredAgentProvider, signal?: AbortSignal) {
    const data = await this.store.runtimeData(turnId); const plan = scenePlanSchema.parse(data.plan);
    if (data.status === 'narrating') {
      const context = await this.store.context(storyId);
      const narration = await this.step(turnId, 'narrating', 'Narrator Agent', () => provider.run('Narrator Agent', layeredPrompt('Narrator Agent', { ...context, fullCharacterIds: plan.participants }, `仅根据已提交事实为这个计划生成正文与选项。不得新增状态：${JSON.stringify(plan)}`, narrationSchema), narrationSchema, signal), value => value.summary);
      await this.store.finalizeNarration(turnId, narration);
    }
    const summarizing = await this.store.runtimeData(turnId);
    if (summarizing.status === 'summarizing') {
      await this.step(turnId, 'summarizing', 'Projection Engine', async () => ({ summary: '角色近期剧情、关系证据和阶段进度已由提交事件投影更新。' }), value => value.summary);
      await this.store.completeTurn(turnId);
    }
    await this.advanceAutoplay(turnId, storyId);
  }

  async runTurn(turnId: string) {
    if (this.stopped) { await this.store.requeue(turnId); return; }
    const claimed = await this.store.claim(turnId); if (!claimed) return;
    if (claimed.busy) { await this.store.requeue(turnId); return; }
    const controller = new AbortController(); this.activeRuns.set(turnId, controller); const signal = controller.signal;
    if (this.stopped) { controller.abort(new Error('Worker is restarting')); await this.store.recordRecoverableError(turnId, 'Worker interrupted before Agent start; turn will resume.'); this.activeRuns.delete(turnId); return; }
    try {
      const initial = await this.store.runtimeData(turnId); const context = await this.store.context(claimed.storyId); const provider = this.resolveProvider(context.config);
      if (claimed.phase === 'narrating' || claimed.phase === 'summarizing') { await this.resumeAfterCommit(turnId, claimed.storyId, provider, signal); return; }
      await this.step(turnId, 'assembling', 'Context Assembler', async () => context, value => `世界版本 ${value.revision}；${value.characters.length} 名角色；${value.facts.length} 条相关事实。`);
      await this.store.setTurnData(turnId, 'context', { revision: context.revision, clock: context.clock, stageId: context.stage?.id, factIds: context.facts.map(fact => fact.id) });
      await this.store.setTurnStatus(turnId, 'directing');
      const autoplay = initial.source === 'autoplay' ? await this.store.autoplay(claimed.storyId) : null;
      let scheduledDuration: number | null = null;
      if (autoplay?.status === 'running') {
        const targetScenes = Math.min(autoplay.maxScenes, Math.max(1, Math.ceil(autoplay.durationMinutes / 360))); const remainingScenes = Math.max(1, targetScenes - autoplay.scenes);
        scheduledDuration = Math.max(1, Math.ceil((autoplay.targetTime - context.clock) / remainingScenes)); const stageText = JSON.stringify(context.stage); if (context.clock < 1440 && context.clock + scheduledDuration > 1440 && /首日|第一日|第一天/.test(stageText)) scheduledDuration = 1440 - context.clock;
      }
      const durationRule = scheduledDuration ? `调度器已确定本场必须持续 ${scheduledDuration} 分钟：当前时间 ${context.clock}，结束时间 ${context.clock + scheduledDuration}。节拍中的所有时间必须与此一致。` : '';
      let plan = this.normalizePlan(await this.step(turnId, 'directing', 'Director Agent', () => provider.run('Director Agent', layeredPrompt('Director Agent', context, `为玩家输入规划一个尚未发生的候选场景。主角必须参与；participants 表示实际到场者，若其当前位置不同，必须添加 location 状态变化记录移动；优先让 heroine、love_interest 或最高聚光核心角色参与长期线。输入确实推进当前阶段时，stageProgressDelta 应在 10–25；不要把候选变化写成既成事实。requiresPlayerChoice 只用于死亡、永久离场、不可逆关系转折或同等级重大决定；普通调查方向应给 choices 但设为 false。${initial.source === 'autoplay' ? '玩家已授权托管普通、可撤回的调查方向；只有上述重大选择才能暂停。' : ''}${durationRule}玩家输入：${initial.input}`, scenePlanSchema), scenePlanSchema, signal), value => `${value.title}；预计 ${value.durationMinutes} 分钟。`), context, initial.source === 'autoplay');
      if (scheduledDuration) plan = scenePlanSchema.parse({ ...plan, durationMinutes: scheduledDuration });
      if (!autoplay) {
        const pausedSession = await this.store.autoplay(claimed.storyId); if (pausedSession?.status === 'paused' && pausedSession.targetTime > context.clock) plan = scenePlanSchema.parse({ ...plan, durationMinutes: Math.min(plan.durationMinutes, pausedSession.targetTime - context.clock) });
      }
      await this.store.setTurnData(turnId, 'plan', plan);
      await this.store.setTurnStatus(turnId, 'reviewing');
      let reviews = await this.reviews(turnId, provider, context, plan, signal);
      let blocking = reviews.flatMap(review => review.issues).filter(issue => issue.severity === 'blocking');
      if (blocking.length) {
        await this.store.setTurnStatus(turnId, 'repairing');
        plan = this.normalizePlan(await this.step(turnId, 'repairing', 'Director Agent', () => provider.run('Director Agent', layeredPrompt('Director Agent', context, `根据以下阻断问题修订一次计划。${durationRule}不得解释：${JSON.stringify(blocking)}。原计划：${JSON.stringify(plan)}`, scenePlanSchema), scenePlanSchema, signal), value => `已修订“${value.title}”。`), context, initial.source === 'autoplay');
        if (scheduledDuration) plan = scenePlanSchema.parse({ ...plan, durationMinutes: scheduledDuration });
        reviews = await this.reviews(turnId, provider, context, plan, signal); blocking = reviews.flatMap(review => review.issues).filter(issue => issue.severity === 'blocking');
      }
      await this.store.setTurnData(turnId, 'plan', plan); await this.store.setTurnData(turnId, 'reviews', reviews);
      if (blocking.length) throw new Error(`规则检查在一次修订后仍失败：${blocking.map(issue => issue.message).join('；')}`);
      await this.store.setTurnStatus(turnId, 'committing');
      await this.step(turnId, 'committing', 'Transaction Committer', () => this.store.commitScene(turnId, plan), value => `已提交场景 ${value.scene.seq} 和 ${value.scene.factIds.length} 条事实。`);
      await this.resumeAfterCommit(turnId, claimed.storyId, provider, signal);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error); const failed = await this.store.runtimeData(turnId);
      if (this.stopped && signal.aborted) { await this.store.recordRecoverableError(turnId, 'Worker interrupted for restart; turn will resume.'); return; }
      if (['narrating', 'summarizing'].includes(failed.status)) await this.store.recordRecoverableError(turnId, message); else await this.store.failTurn(turnId, message);
      const data = await this.store.runtimeData(turnId); if (data.source === 'autoplay') { const session = await this.store.autoplay(data.storyId); if (session?.status === 'running') { session.status = 'paused'; session.pauseReason = `Provider 或规则失败：${message}`; await this.store.updateAutoplay(session); } }
    } finally { this.activeRuns.delete(turnId); }
  }

  private async advanceAutoplay(turnId: string, storyId: string) {
    const turn = await this.store.turn(turnId); if (turn.source !== 'autoplay') return;
    const session = await this.store.autoplay(storyId); if (!session || session.status !== 'running') return;
    const state = await this.store.state(storyId); session.scenes += 1;
    if (turn.status === 'waiting_player') { session.status = 'paused'; session.pauseReason = turn.waitingReason; }
    else if (state.clock >= session.targetTime) { session.status = 'completed'; session.pauseReason = null; }
    else { const boundary = stageTimeBoundary(state.activeStage); if (boundary && state.clock >= boundary && await this.store.closeStageAtBoundary(storyId, boundary, turnId)) { session.status = 'paused'; session.pauseReason = '阶段时间边界已到，请审核下一阶段提案。'; } }
    if (session.status === 'running' && session.scenes >= session.maxScenes) { session.status = 'paused'; session.pauseReason = '已达到单次托管场景上限。'; }
    await this.store.updateAutoplay(session);
    if (session.status === 'running' && !this.stopped) {
      await this.store.enqueueTurn(storyId, '沿当前阶段目标继续推进，避免替主角作出重大决定。', 'autoplay', `autoplay:${session.id}:${session.scenes + 1}`);
      await this.store.flushOutbox();
    }
  }

  async startAutoplay(storyId: string, requestInput: unknown) {
    const request = autoplayRequestSchema.parse(requestInput); const session = await this.store.createAutoplay(storyId, request);
    const turn = await this.store.enqueueTurn(storyId, '沿当前阶段目标开始托管推进，保持角色主动性与事实连续。', 'autoplay', `autoplay:${session.id}:1`); await this.store.recordAutoplayAuthorization(storyId, turn.id, session); await this.store.flushOutbox(); return session;
  }

  async reviewStageProposal(storyId: string, proposalId: string, decision: 'accept' | 'reject') {
    const result = await this.store.reviewProposal(storyId, proposalId, decision); const session = await this.store.autoplay(storyId);
    if (decision === 'accept' && session?.status === 'paused' && session.pauseReason?.includes('阶段')) {
      const state = await this.store.state(storyId); if (state.clock < session.targetTime && session.scenes < session.maxScenes) {
        session.status = 'running'; session.pauseReason = null; await this.store.updateAutoplay(session);
        await this.store.enqueueTurn(storyId, '玩家已确认下一阶段，继续托管推进。', 'autoplay', `autoplay:${session.id}:${session.scenes + 1}:${randomUUID()}`); await this.store.flushOutbox();
      }
    }
    return result;
  }

  async resumeAutoplay(storyId: string) {
    const session = await this.store.autoplay(storyId); if (!session || session.status !== 'paused') throw new Error('AUTOPLAY_NOT_PAUSED');
    if (await this.store.pendingProposal(storyId)) throw new Error('STAGE_PROPOSAL_REQUIRES_REVIEW'); const state = await this.store.state(storyId);
    if (state.clock >= session.targetTime) { session.status = 'completed'; session.pauseReason = null; await this.store.updateAutoplay(session); return session; }
    const boundary = stageTimeBoundary(state.activeStage); if (boundary && state.latestTurn && state.clock >= boundary && await this.store.closeStageAtBoundary(storyId, boundary, state.latestTurn.id)) { session.pauseReason = '阶段时间边界已到，请审核下一阶段提案。'; await this.store.updateAutoplay(session); return session; }
    session.status = 'running'; session.pauseReason = null; await this.store.updateAutoplay(session);
    await this.store.enqueueTurn(storyId, '玩家已处理暂停事项，继续沿当前阶段目标托管推进。', 'autoplay', `autoplay:${session.id}:${session.scenes + 1}:${randomUUID()}`); await this.store.flushOutbox(); return session;
  }
}
