import { z } from 'zod';

const key = z.string().min(1).max(100).regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/);
const uuid = z.string().uuid();
export const evidenceSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('fact'), factId: uuid }).strict(),
  z.object({ type: z.literal('change'), index: z.number().int().min(0).max(15) }).strict(),
]);
export const memoryAnnotationSchema = z.object({
  evidence: evidenceSchema, quote: z.string().min(1).max(1200),
  characterIds: z.array(key).max(12).default([]), locationNames: z.array(z.string().min(1).max(100)).max(8).default([]),
  topics: z.array(z.string().min(1).max(80)).max(12).default([]),
  aliases: z.array(z.object({ characterId: key, alias: z.string().min(1).max(60) }).strict()).max(12).default([]),
  locationAliases:z.array(z.object({name:z.string().min(1).max(100),alias:z.string().min(1).max(100)}).strict()).max(8).default([]),
}).strict();
export const threadUpdateSchema = z.object({
  id: key, kind: z.enum(['promise', 'clue', 'conflict']), title: z.string().min(1).max(300),
  status: z.enum(['open', 'resolved', 'cancelled']), characterIds: z.array(key).max(12),
  evidence: z.array(evidenceSchema).min(1).max(12), quote: z.string().min(1).max(1200),
}).strict();
export const memoryExtractionSchema = z.object({ annotations: z.array(memoryAnnotationSchema).max(50), threads: z.array(threadUpdateSchema).max(30) }).strict();
export type MemoryExtraction = z.infer<typeof memoryExtractionSchema>;
export const storyThreadSchema = threadUpdateSchema.omit({ evidence: true, quote: true }).extend({
  evidenceFactIds: z.array(uuid), sourceQuotes: z.array(z.string()), updatedSeq: z.number().int(),
  verified: z.boolean(), visibility: z.enum(['public', 'player', 'private']),
});
export type StoryThread = z.infer<typeof storyThreadSchema>;
export interface MemoryEntity { id: string; type: 'character' | 'location'; name: string; aliases: string[] }
export interface MemoryHit { factId: string; score: number; reasons: string[] }

export const narrativeClaimSchema = z.object({
  id: key, text: z.string().min(1).max(1200).describe('逐字摘自 prose 对应段落的连续原文，不可改述；此文字必须也出现在对应 segment.text 中。'), factIds: z.array(uuid).min(1).max(12),
  mode: z.enum(['event', 'reported', 'uncertain']), speakerId: key.nullable().default(null),
}).strict();
export const narrativeSegmentSchema = z.object({ id: key, text: z.string().min(1).max(8000), claimIds: z.array(key).max(30) }).strict();
export type NarrativeClaim = z.infer<typeof narrativeClaimSchema>;
export type NarrativeSegment = z.infer<typeof narrativeSegmentSchema>;

const conditionAtom = z.discriminatedUnion('type', [
  z.object({ type: z.literal('outcome'), values: z.array(z.enum(['success', 'partial', 'failure', 'abandoned'])).min(1) }).strict(),
  z.object({ type: z.literal('milestone'), milestoneId: key, achieved: z.boolean() }).strict(),
  z.object({ type: z.literal('assertion'), key, value: z.boolean() }).strict(),
]);
export const routeConditionSchema = z.object({ mode: z.enum(['all', 'any']), tests: z.array(conditionAtom).min(1).max(12) }).strict();
export const storyRouteSchema = z.object({ id: key, from: key, to: key, label: z.string().min(1).max(120), condition: routeConditionSchema.nullable(), fallback: z.boolean().default(false) }).strict();
export const stageGraphSchema = z.object({ revision: z.number().int().positive().default(1), entry: key, routes: z.array(storyRouteSchema).max(60) }).strict();
export type StageGraph = z.infer<typeof stageGraphSchema>;
export const assertionUpdateSchema = z.object({ key, value: z.boolean(), evidence: z.array(evidenceSchema).min(1).max(12), reason: z.string().min(1).max(500) }).strict();

export const resourcePanelSchema = z.object({
  stamina: z.number().int().min(0).max(100).default(100), injury: z.number().int().min(0).max(3).default(0), money: z.number().int().min(0).max(100000000).default(100),
  attributes: z.object({ physical: z.number().int().min(0).max(5), insight: z.number().int().min(0).max(5), social: z.number().int().min(0).max(5) }).default({ physical: 2, insight: 2, social: 2 }),
  skills: z.object({ sneak: z.number().int().min(0).max(5), negotiate: z.number().int().min(0).max(5), force: z.number().int().min(0).max(5), investigate: z.number().int().min(0).max(5), specialty: z.number().int().min(0).max(5) }).default({ sneak: 1, negotiate: 1, force: 1, investigate: 1, specialty: 1 }),
  energy: z.number().int().min(0).max(30).default(30), spellSlots: z.number().int().min(0).max(3).default(3), shield: z.boolean().default(false), illuminated:z.boolean().default(false), trace: z.number().int().min(0).max(3).default(0),
}).strict();
export type ResourcePanel = z.infer<typeof resourcePanelSchema>;
export const resourceIntentSchema = z.object({
  actorId: key, targetId: key,
  method: z.enum(['sneak', 'negotiate', 'force', 'investigate', 'rest', 'long_rest', 'meditate', 'technique', 'illuminate', 'shield', 'unlock', 'hack', 'recharge', 'treat', 'trade', 'reward']),
  itemId: key.nullable().default(null), evidenceFactIds: z.array(uuid).max(12).default([]),
}).strict();
export type ResourceIntent = z.infer<typeof resourceIntentSchema>;
export const challengeSchema = z.object({
  id: key, title: z.string().min(1).max(200), difficulty: z.enum(['easy', 'normal', 'hard']).default('normal'),
  methods: z.array(resourceIntentSchema.shape.method).min(1), requiredItemId: key.nullable().default(null),
  revision: z.number().int().positive().default(1), evidenceFactIds: z.array(uuid).max(12).default([]),
  price: z.number().int().min(0).default(0), rewardMoney: z.number().int().min(0).default(0), itemId: key.nullable().default(null),
  ownerId: key.nullable().default(null), facility: z.boolean().default(false), rewardClaimed:z.boolean().default(false), state: z.enum(['open', 'passed', 'failed']).default('open'),
}).strict();
export type Challenge = z.infer<typeof challengeSchema>;
export const actionQuoteSchema=z.object({intent:resourceIntentSchema,cost:z.number().int().nonnegative(),minutes:z.number().int().positive(),modifier:z.number(),dc:z.number().nullable(),probability:z.number().min(0).max(1),money:z.number().int().nonnegative(),requiresConfirmation:z.boolean(),label:z.string(),fingerprint:z.string()}).strict();
export const resourceStateSchema = z.object({
  enabled:z.boolean(), ruleset:z.enum(['cultivation','western_fantasy','science_fiction','modern_mystery','custom']),version:z.number().int().positive(),panels:z.record(key,resourcePanelSchema),
  items:z.array(z.object({id:key,name:z.string().min(1).max(100),ownerId:key,consumed:z.boolean()}).strict()),challenges:z.array(challengeSchema),
  attempts:z.array(z.object({key:z.string(),intent:resourceIntentSchema,roll:z.number().int().min(1).max(20).nullable(),success:z.boolean(),result:z.string(),cost:z.number().int().nonnegative(),minutes:z.number().int().positive(),committed:z.boolean(),turnId:uuid,fingerprint:z.string(),quote:actionQuoteSchema.optional()}).strict()),
  alerts:z.record(key,z.number().int().min(0).max(3)).default({}),
}).strict();
export type ResourceState = z.infer<typeof resourceStateSchema>;

export const knowledgeUpdateSchema = z.object({
  characterId: key, evidence: evidenceSchema, mode: z.enum(['observed', 'reported', 'inferred']),
  belief: z.enum(['accepted', 'doubted', 'rejected']).default('accepted'), concealed: z.boolean().default(false),
  sourceCharacterId: key.nullable().default(null),
}).strict();
export const knowledgeEntrySchema=knowledgeUpdateSchema.omit({evidence:true}).extend({id:key,factId:uuid,learnedAt:z.number().int().nonnegative()}).strict();
export type KnowledgeEntry=z.infer<typeof knowledgeEntrySchema>;
export const npcGoalSchema = z.object({
  id: key, actorId: key, kind: z.enum(['goal', 'promise', 'faction']), title: z.string().min(1).max(300),
  dueMinutes: z.number().int().min(0), triggerFactIds: z.array(uuid).max(12).default([]),
  evidenceFactIds: z.array(uuid).min(1).max(12), status: z.enum(['pending', 'warned', 'completed', 'cancelled']).default('pending'),
  irreversible: z.boolean().default(false), warningFactId: uuid.nullable().default(null), warningClock: z.number().int().nullable().default(null), warningSceneSeq: z.number().int().nullable().default(null),
  action: resourceIntentSchema.nullable().default(null),
  triggerStageId: uuid.nullable().default(null),
}).strict();
export type NpcGoal = z.infer<typeof npcGoalSchema>;
export const npcGoalUpdateSchema=npcGoalSchema.omit({evidenceFactIds:true,status:true,warningFactId:true,warningClock:true,warningSceneSeq:true}).extend({evidence:z.array(evidenceSchema).min(1).max(12),cancel:z.boolean().default(false)}).strict();
export const npcUseSchema=z.object({characterId:key,factId:uuid,changeIndex:z.number().int().min(0).max(15)}).strict();
export const experienceStateSchema = z.object({
  revision: z.number().int().positive().default(1), threads: z.array(storyThreadSchema).default([]),
  assertions: z.record(z.string(), z.object({ value: z.boolean(), evidenceFactIds: z.array(uuid) })).default({}),
  knowledge: z.array(knowledgeEntrySchema).default([]), goals: z.array(npcGoalSchema).default([]),
  resources: resourceStateSchema.nullable().default(null),
}).strict();
export type ExperienceState = z.infer<typeof experienceStateSchema>;
