import { z } from 'zod';

export const idSchema = z.string().min(1).max(100).regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/);
export const uuidSchema = z.string().uuid();
export const genreSchema = z.enum(['cultivation', 'western_fantasy', 'science_fiction', 'modern_mystery', 'custom']);
export const providerSchema = z.enum(['codex', 'openai', 'deterministic']);

export const storyWorldConfigSchema = z.object({
  title: z.string().trim().min(1).max(80),
  genre: genreSchema,
  premise: z.string().trim().min(1).max(2000),
  tone: z.string().trim().min(1).max(200),
  pacing: z.enum(['slow', 'balanced', 'fast']).default('balanced'),
  worldRules: z.array(z.string().trim().min(1).max(300)).max(30).default([]),
  terminology: z.record(z.string().max(60), z.string().max(120)).default({}),
  contentBoundaries: z.array(z.string().trim().min(1).max(200)).max(30).default([]),
  storyPacks: z.array(idSchema).max(12).default([]),
  advancedPrompt: z.string().max(12000).default(''),
  provider: providerSchema.default('codex'),
}).strict();
export type StoryWorldConfig = z.infer<typeof storyWorldConfigSchema>;

export const stageDraftSchema = z.object({
  title: z.string().trim().min(1).max(100),
  objective: z.string().trim().min(1).max(800),
  entryCriteria: z.array(z.string().min(1).max(240)).max(12).default([]),
  completionCriteria: z.array(z.string().min(1).max(240)).min(1).max(12),
  failureConditions: z.array(z.string().min(1).max(240)).max(12).default([]),
  boundaries: z.array(z.string().min(1).max(240)).max(12).default([]),
  desiredBeats: z.array(z.string().min(1).max(240)).min(1).max(12),
}).strict();
export type StageDraft = z.infer<typeof stageDraftSchema>;

export const characterDraftSchema = z.object({
  id: idSchema,
  name: z.string().trim().min(1).max(60),
  importance: z.enum(['protagonist', 'core', 'supporting', 'background']),
  roleTags: z.array(idSchema).max(12).default([]),
  publicProfile: z.string().trim().min(1).max(1000),
  privateProfile: z.string().trim().max(1000).default(''),
  drives: z.array(z.string().min(1).max(180)).max(8).default([]),
  fears: z.array(z.string().min(1).max(180)).max(8).default([]),
  location: z.string().trim().min(1).max(100),
}).strict();
export type CharacterDraft = z.infer<typeof characterDraftSchema>;

export const outlineDraftSchema = z.object({
  title: z.string().trim().min(1).max(80),
  premise: z.string().trim().min(1).max(2000),
  arcObjective: z.string().trim().min(1).max(800),
  stakes: z.string().trim().min(1).max(600),
  stages: z.array(stageDraftSchema).min(4).max(6),
  characters: z.array(characterDraftSchema).min(4).max(6),
}).strict().superRefine((value, ctx) => {
  const ids = new Set(value.characters.map(character => character.id));
  if (ids.size !== value.characters.length) ctx.addIssue({ code: 'custom', path: ['characters'], message: '角色 ID 必须唯一' });
  if (value.characters.filter(character => character.importance === 'protagonist').length !== 1) ctx.addIssue({ code: 'custom', path: ['characters'], message: '必须且只能有一名主角' });
  if (!value.characters.some(character => character.roleTags.some(tag => ['heroine', 'love_interest'].includes(tag)))) ctx.addIssue({ code: 'custom', path: ['characters'], message: '至少需要一名女主或恋爱对象标签角色' });
});
export type OutlineDraft = z.infer<typeof outlineDraftSchema>;

export const storyStageSchema = stageDraftSchema.extend({
  id: uuidSchema,
  position: z.number().int().min(0),
  status: z.enum(['planned', 'active', 'completed', 'failed']),
  progress: z.number().int().min(0).max(100),
  revision: z.number().int().min(1),
});
export type StoryStage = z.infer<typeof storyStageSchema>;

export const characterSchema = characterDraftSchema.extend({
  mood: z.string().max(120).default('平静'),
  condition: z.string().max(120).default('状态稳定'),
  currentGoal: z.string().max(500).default(''),
  recentBeat: z.string().max(800).default(''),
  unresolvedHooks: z.array(z.string().max(300)).max(12).default([]),
  lastSceneSeq: z.number().int().min(0).default(0),
  spotlight: z.number().int().min(0).max(100).default(50),
  version: z.number().int().min(1).default(1),
});
export type Character = z.infer<typeof characterSchema>;

export const relationshipSchema = z.object({
  id: uuidSchema,
  from: idSchema,
  to: idSchema,
  trust: z.number().int().min(-100).max(100),
  affinity: z.number().int().min(-100).max(100),
  tension: z.number().int().min(0).max(100),
  summary: z.string().max(600),
  evidenceFactIds: z.array(uuidSchema).max(30),
  version: z.number().int().min(1),
}).strict();
export type Relationship = z.infer<typeof relationshipSchema>;

export const factSchema = z.object({
  id: uuidSchema,
  seq: z.number().int().positive(),
  time: z.number().int().min(0),
  kind: z.enum(['action', 'dialogue', 'relationship', 'character', 'stage', 'world']),
  text: z.string().min(1).max(1200),
  tags: z.array(z.string().max(100)).max(20),
  visibility: z.enum(['public', 'player', 'private']),
  sourceTurnId: uuidSchema,
  payload: z.record(z.string(), z.unknown()).nullable().default(null),
}).strict();
export type CanonicalFact = z.infer<typeof factSchema>;

export const stateChangeSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('character'), characterId: idSchema, field: z.enum(['mood', 'condition', 'location', 'currentGoal', 'recentBeat', 'hook']), value: z.string().min(1).max(600), significance: z.enum(['minor', 'major']) }).strict(),
  z.object({ type: z.literal('relationship'), from: idSchema, to: idSchema, dimension: z.enum(['trust', 'affinity', 'tension']), delta: z.number().int().min(-5).max(5), reason: z.string().min(1).max(400), significance: z.enum(['minor', 'major']) }).strict(),
  z.object({ type: z.literal('fact'), kind: z.enum(['action', 'dialogue', 'world']), text: z.string().min(1).max(1000), tags: z.array(z.string().max(100)).min(1).max(12) }).strict(),
]);
export type StateChange = z.infer<typeof stateChangeSchema>;

export const scenePlanSchema = z.object({
  title: z.string().trim().min(1).max(120),
  objective: z.string().trim().min(1).max(600),
  location: z.string().trim().min(1).max(100),
  participants: z.array(idSchema).min(1).max(12),
  durationMinutes: z.number().int().min(1).max(1440),
  beats: z.array(z.string().min(1).max(300)).min(1).max(8),
  changes: z.array(stateChangeSchema).min(1).max(16),
  stageProgressDelta: z.number().int().min(0).max(30),
  requiresPlayerChoice: z.boolean(),
  choicePrompt: z.string().max(500).nullable(),
  choices: z.array(z.string().min(1).max(240)).max(5),
  checkTags: z.array(idSchema).max(12),
}).strict();
export type ScenePlan = z.infer<typeof scenePlanSchema>;

export const reviewSchema = z.object({
  approved: z.boolean(),
  summary: z.string().min(1).max(500),
  issues: z.array(z.object({ code: idSchema, message: z.string().min(1).max(500), severity: z.enum(['warning', 'blocking']) }).strict()).max(12),
}).strict();
export type AgentReview = z.infer<typeof reviewSchema>;

export const narrationSchema = z.object({
  title: z.string().min(1).max(120),
  prose: z.string().min(1).max(8000),
  summary: z.string().min(1).max(1000),
  choices: z.array(z.string().min(1).max(240)).max(5),
}).strict();
export type Narration = z.infer<typeof narrationSchema>;

export const sceneSchema = z.object({
  id: uuidSchema,
  turnId: uuidSchema,
  seq: z.number().int().positive(),
  startTime: z.number().int().min(0),
  endTime: z.number().int().min(0),
  location: z.string().min(1).max(100),
  title: z.string().min(1).max(120),
  prose: z.string().min(1).max(8000),
  summary: z.string().min(1).max(1000),
  participants: z.array(idSchema),
  factIds: z.array(uuidSchema),
  choices: z.array(z.string().max(240)),
}).strict();
export type Scene = z.infer<typeof sceneSchema>;

export const turnSourceSchema = z.enum(['web', 'codex', 'autoplay', 'test']);
export const turnStatusSchema = z.enum(['queued', 'assembling', 'directing', 'reviewing', 'repairing', 'committing', 'narrating', 'summarizing', 'completed', 'waiting_player', 'failed']);
export type TurnStatus = z.infer<typeof turnStatusSchema>;
export const turnStepNameSchema = z.enum(['assembling', 'directing', 'continuity', 'stage', 'agency', 'character', 'pack', 'repairing', 'committing', 'narrating', 'summarizing']);
export const turnStepSchema = z.object({ id: uuidSchema, name: turnStepNameSchema, agentRole: z.string().max(100), status: z.enum(['running', 'completed', 'failed']), summary: z.string().max(800), startedAt: z.number().int(), completedAt: z.number().int().nullable() }).strict();
export type TurnStep = z.infer<typeof turnStepSchema>;

export const storyTurnSchema = z.object({
  id: uuidSchema,
  storyId: uuidSchema,
  source: turnSourceSchema,
  input: z.string().min(1).max(4000),
  status: turnStatusSchema,
  currentStep: z.string().max(100),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
  waitingReason: z.string().max(800).nullable(),
  error: z.string().max(1200).nullable(),
  scene: sceneSchema.nullable(),
  steps: z.array(turnStepSchema),
}).strict();
export type StoryTurn = z.infer<typeof storyTurnSchema>;

export const autoplayRequestSchema = z.object({ durationMinutes: z.number().int().min(60).max(43200), maxScenes: z.number().int().min(1).max(50).default(50) }).strict();
export type AutoplayRequest = z.infer<typeof autoplayRequestSchema>;
export const autoplaySessionSchema = autoplayRequestSchema.extend({ id: uuidSchema, storyId: uuidSchema, startTime: z.number().int().min(0), targetTime: z.number().int().min(1), scenes: z.number().int().min(0), status: z.enum(['running', 'paused', 'completed', 'stopped']), pauseReason: z.string().max(800).nullable() });
export type AutoplaySession = z.infer<typeof autoplaySessionSchema>;

export const createStoryRequestSchema = z.object({ config: storyWorldConfigSchema, seed: z.number().int().min(1).max(2147483647).optional() }).strict();
export const createTurnRequestSchema = z.object({ input: z.string().trim().min(1).max(4000), source: turnSourceSchema.default('web'), idempotencyKey: z.string().min(8).max(120) }).strict();

export interface StoryStateView {
  id: string; branch: string; title: string; status: 'draft' | 'active' | 'archived'; clock: number; revision: number;
  config: StoryWorldConfig; outline: OutlineDraft | null; arc: { objective: string; stakes: string } | null;
  activeStage: StoryStage | null; stages: StoryStage[]; characters: Character[]; relationships: Relationship[];
  scenes: Scene[]; facts: CanonicalFact[]; latestTurn: StoryTurn | null; autoplay: AutoplaySession | null;
}
