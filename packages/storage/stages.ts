import { createHash } from 'node:crypto';
import { storyStageSchema, type StoryStage, type ScenePlan, type CanonicalFact } from '../contracts/index.ts';

export function initializeMilestones(stage: StoryStage): StoryStage {
  return storyStageSchema.parse({ ...stage, milestones: stage.completionCriteria.map((criterion, index) => ({
    id: stage.milestones.find(m => m.criterion === criterion)?.id ?? stage.milestoneIds[index] ?? `milestone_${createHash('sha256').update(`${stage.nodeId ?? stage.id}:${criterion}`).digest('hex').slice(0, 24)}`,
    criterion, status: 'pending', evidenceFactIds: [],
  })).filter((item, index, all) => all.findIndex(other => other.id === item.id) === index) });
}

// Used only by the v1 migration. New games carry an explicit deadline.
export function legacyDeadline(stage: StoryStage) {
  for (const [pattern, value] of [[/首日|第一日|第一天/, 1440], [/第二日|第二天|第二夜/, 2880], [/第三日|第三天|第三夜/, 4320]] as const) {
    if (pattern.test(stage.title)) return value;
    if (new RegExp(`(?:${pattern.source})(?:内|结束前|结束时|截止)`).test([stage.objective, ...stage.completionCriteria].join('\n'))) return value;
  }
  return null;
}

export const majorPattern = /死亡|杀死|牺牲|永久离场|不可逆|决裂|终身|处决|death|permanent|irreversible/i;
export function majorChangeIndices(plan: ScenePlan) {
  const indices = plan.changes.flatMap((change, index) => ('significance' in change && change.significance === 'major') || majorPattern.test(JSON.stringify(change)) ? [index] : []);
  const flagged = plan.checkTags.some(tag => ['death', 'permanent_exit', 'irreversible', 'major_relationship', 'critical_choice'].includes(tag));
  return indices.length || !flagged ? indices : plan.changes.map((_, index) => index);
}

export function isMilestoneEvidence(fact: CanonicalFact) {
  const change = fact.payload?.change as { type?: string; field?: string } | undefined;
  return ['character', 'relationship', 'fact'].includes(String(fact.payload?.type))
    && fact.kind !== 'stage'
    && !(change?.type === 'character' && ['currentGoal', 'hook'].includes(change.field ?? ''))
    && !['stage', 'scene', 'decision_point', 'awaiting_player', 'player_choice', 'autoplay', 'autoplay_authorized'].some(tag => fact.tags.includes(tag))
    && !/(?:阶段|里程碑).{0,50}(?:已?完成|达成|进度|100%)|完成.{0,12}(?:阶段|里程碑)|候选|计划将|等待玩家/.test(fact.text);
}

export function stageProgress(stage: StoryStage) {
  return stage.milestones.length ? Math.floor(100 * stage.milestones.filter(item => item.status === 'achieved').length / stage.milestones.length) : 0;
}
