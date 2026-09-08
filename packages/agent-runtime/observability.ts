import { randomUUID } from 'node:crypto';
import type { StoryStore, RuntimeContext } from '../storage/store.ts';
import type { StructuredAgentProvider } from './provider.ts';
import type { ScenePlan } from '../contracts/index.ts';
import { majorChangeIndices } from '../storage/stages.ts';

export function lowRiskPlan(context: RuntimeContext, plan: ScenePlan) {
  return context.config.fastReview && !context.confirmedDecision && !plan.requiresPlayerChoice && !plan.resourceIntent && !majorChangeIndices(plan).length
    && !plan.npcEffects.length && !plan.npcUses.length && !plan.observations.some(o=>o.recipientIds.length) && !plan.knowledgeUpdates.length && !plan.memoryAnnotations.length && !(context.experience?.goals.some(g => g.status === 'pending' && g.dueMinutes <= context.clock + plan.durationMinutes))
    && (context.stage?.deadlineMinutes == null || context.clock + plan.durationMinutes < context.stage.deadlineMinutes)
    && plan.changes.every(change => change.type === 'character' && change.significance === 'minor' && ['mood', 'recentBeat'].includes(change.field)
      || change.type === 'fact' && change.kind === 'dialogue' && !/秘密|承诺|答应|证据|确认|杀|死|交出|归还|获得|失去|决定/.test(change.text))
    && /观察|闲聊|闲谈|问候|看看|聊天/.test(`${plan.objective} ${plan.checkTags.join(' ')}`);
}
export function measuredProvider(store: StoryStore, storyId: string, turnId: string, provider: StructuredAgentProvider): StructuredAgentProvider {
  return { name: provider.name, async run(role, instructions, schema, signal) {
    const id = randomUUID(); let usage: Record<string, unknown> = { requests: 1, inputTokens: null, outputTokens: null, usageKnown: false };
    await store.database.pool.query('INSERT INTO turn_observations(id,story_id,turn_id,name,started_at,data) VALUES($1,$2,$3,$4,$5,$6)', [id, storyId, turnId, `model:${role}`, Date.now(), usage]);
    let failed = false;
    try { return await provider.run(role, instructions, schema, signal, value => { usage = value; }); }
    catch (e) { failed = true; throw e; }
    finally { await store.database.pool.query('UPDATE turn_observations SET completed_at=$2,data=$3 WHERE id=$1', [id, Date.now(), { ...usage, failed, promptCharacters: instructions.length }]); }
  } };
}
export const distribution = (values: number[]) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  return { samples: sorted.length, p50: sorted.length ? sorted[Math.ceil(sorted.length * .5) - 1] : null, p95: sorted.length ? sorted[Math.ceil(sorted.length * .95) - 1] : null };
};
