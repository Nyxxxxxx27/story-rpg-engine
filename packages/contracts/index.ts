import { z } from 'zod';
import { memoryAnnotationSchema, threadUpdateSchema, narrativeClaimSchema, narrativeSegmentSchema, stageGraphSchema, assertionUpdateSchema, resourceIntentSchema, resourcePanelSchema, knowledgeUpdateSchema, npcGoalUpdateSchema, npcUseSchema } from './experience.ts';
export * from './experience.ts';

export const idSchema = z.string().min(1).max(100).regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/);
export const uuidSchema = z.string().uuid();
export const genreSchema = z.enum(['cultivation', 'western_fantasy', 'science_fiction', 'modern_mystery', 'custom']);
export const providerSchema = z.enum(['codex', 'openai', 'deterministic']);
export const polishModeSchema = z.enum(['off', 'standard']);

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
  polishMode: polishModeSchema.default('standard'),
  romanceMode: z.enum(['off', 'player_led', 'organic']).default('organic'),
  fastReview: z.boolean().default(true),
  rulesAtStart: z.boolean().default(true),
}).strict();
export type StoryWorldConfig = z.infer<typeof storyWorldConfigSchema>;

export const stageDraftSchema = z.object({
  nodeId: idSchema.optional(),
  milestoneIds: z.array(idSchema).max(12).default([]),
  terminal: z.boolean().default(false),
  entryBudgetMinutes: z.number().int().positive().nullable().default(null),
  title: z.string().trim().min(1).max(100),
  objective: z.string().trim().min(1).max(800),
  entryCriteria: z.array(z.string().min(1).max(240)).max(12).default([]),
  completionCriteria: z.array(z.string().min(1).max(240)).min(1).max(12),
  failureConditions: z.array(z.string().min(1).max(240)).max(12).default([]),
  boundaries: z.array(z.string().min(1).max(240)).max(12).default([]),
  desiredBeats: z.array(z.string().min(1).max(240)).min(1).max(12),
  deadlineMinutes: z.number().int().min(1).nullable().default(null),
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
  stages: z.array(stageDraftSchema).min(4).max(12),
  graph: stageGraphSchema.optional(),
  assertionDefinitions: z.array(z.object({ key: idSchema, description: z.string().min(1).max(500) }).strict()).max(30).default([]),
  startingPanels: z.record(idSchema,resourcePanelSchema).default({}),
  characters: z.array(characterDraftSchema).min(4).max(6),
}).strict().superRefine((value, ctx) => {
  const ids = new Set(value.characters.map(character => character.id));
  if (ids.size !== value.characters.length) ctx.addIssue({ code: 'custom', path: ['characters'], message: '角色 ID 必须唯一' });
  if (value.characters.filter(character => character.importance === 'protagonist').length !== 1) ctx.addIssue({ code: 'custom', path: ['characters'], message: '必须且只能有一名主角' });
});
export type OutlineDraft = z.infer<typeof outlineDraftSchema>;

export const milestoneSchema = z.object({
  id: idSchema, criterion: z.string().min(1).max(240),
  status: z.enum(['pending', 'achieved']).default('pending'),
  evidenceFactIds: z.array(uuidSchema).max(30).default([]),
}).strict();
export const storyStageSchema = stageDraftSchema.extend({
  id: uuidSchema,
  position: z.number().int().min(0),
  status: z.enum(['planned', 'active', 'completed', 'failed', 'closed']),
  progress: z.number().int().min(0).max(100),
  revision: z.number().int().min(1),
  milestones: z.array(milestoneSchema).max(12).default([]),
  outcome: z.enum(['success', 'partial', 'failure', 'abandoned']).nullable().default(null),
  failureReason: z.string().max(500).nullable().default(null),
  failureEvidenceFactIds: z.array(uuidSchema).max(30).default([]),
  awaitingDeadline: z.boolean().default(false),
  legacyProgress: z.number().int().min(0).max(100).nullable().default(null),
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
  // Accepted when resuming v1 plans; never used for v2 progression.
  stageProgressDelta: z.number().int().min(0).max(30).default(0),
  requiresPlayerChoice: z.boolean(),
  choicePrompt: z.string().max(500).nullable(),
  choices: z.array(z.string().min(1).max(240)).max(5),
  checkTags: z.array(idSchema).max(12),
  memoryAnnotations: z.array(memoryAnnotationSchema).max(30).default([]),
  knowledgeUpdates: z.array(knowledgeUpdateSchema).max(30).default([]),
  observations: z.array(z.object({changeIndex:z.number().int().min(0).max(15),witnessIds:z.array(idSchema).max(12),recipientIds:z.array(idSchema).max(12),speakerId:idSchema.nullable()}).strict()).max(16).default([]),
  npcUses: z.array(npcUseSchema).max(30).default([]),
  npcEffects: z.array(z.object({goalId:idSchema,indices:z.array(z.number().int().min(0).max(15)),warning:z.boolean()}).strict()).max(2).default([]),
  resourceIntent: resourceIntentSchema.nullable().default(null),
  failureChanges: z.array(stateChangeSchema).max(16).default([]),
}).strict();
export type ScenePlan = z.infer<typeof scenePlanSchema>;

export const reviewSchema = z.object({
  approved: z.boolean(),
  summary: z.string().min(1).max(500),
  issues: z.array(z.object({ code: idSchema, message: z.string().min(1).max(500), severity: z.enum(['warning', 'blocking']) }).strict()).max(12),
}).strict();
export type AgentReview = z.infer<typeof reviewSchema>;

export const evidenceReferenceSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('fact'), factId: uuidSchema }).strict(),
  z.object({ type: z.literal('change'), index: z.number().int().min(0).max(15) }).strict(),
]);
export const stageReviewSchema = reviewSchema.extend({
  npcGoals: z.array(npcGoalUpdateSchema).max(8).default([]),
  threadUpdates: z.array(threadUpdateSchema).max(20).default([]),
  assertions: z.array(assertionUpdateSchema).max(20).default([]),
  milestones: z.array(z.object({ milestoneId: idSchema, evidence: z.array(evidenceReferenceSchema).min(1).max(30), reason: z.string().min(1).max(500) }).strict()).max(12).default([]),
  failure: z.object({ conditionIndex: z.number().int().min(0).max(11), evidence: z.array(evidenceReferenceSchema).min(1).max(30), reason: z.string().min(1).max(500) }).strict().nullable().default(null),
});
export type StageReview = z.infer<typeof stageReviewSchema>;
export const agencyReviewSchema = reviewSchema.extend({
  authorizedChangeIndices: z.array(z.number().int().min(0).max(15)).max(16).default([]),
  confirmedActionCovered: z.boolean().default(false),
});
export type AgencyReview = z.infer<typeof agencyReviewSchema>;

export const narrationSchema = z.object({
  title: z.string().min(1).max(120),
  prose: z.string().min(1).max(8000),
  summary: z.string().min(1).max(1000),
  choices: z.array(z.string().min(1).max(240)).max(5),
  claims: z.array(narrativeClaimSchema).max(40).default([]),
  segments: z.array(narrativeSegmentSchema).max(40).default([]),
}).strict();
export type Narration = z.infer<typeof narrationSchema>;

export const prosePolishSchema = z.object({ prose: z.string().min(1).max(8000) }).strict();
export type ProsePolish = z.infer<typeof prosePolishSchema>;

export const sceneOptionSchema = z.object({ id: idSchema, text: z.string().min(1).max(500) }).strict();
export const decisionSchema = z.object({
  id: uuidSchema, storyId: uuidSchema, sceneId: uuidSchema, turnId: uuidSchema,
  stageId: uuidSchema.nullable(), prompt: z.string().max(800), options: z.array(sceneOptionSchema).max(5),
  status: z.enum(['pending', 'resolved', 'superseded']), choice: z.string().max(4000).nullable(),
  selectedOptionId: idSchema.nullable().default(null),
  actionIntent: resourceIntentSchema.nullable().default(null),
  continuationTurnId: uuidSchema.nullable(),
}).strict();
export type StoryDecision = z.infer<typeof decisionSchema>;
export const narrationValidationSchema = z.object({
  mode: z.enum(['rules', 'semantic', 'fallback']), issues: z.array(z.string().max(800)).max(30),
  semanticCalls: z.number().int().min(0), repairs: z.number().int().min(0).max(1), checkedAt: z.number().int(),
}).strict();
export type NarrationValidation = z.infer<typeof narrationValidationSchema>;
export const narrationReviewSchema = z.object({
  draftApproved: z.boolean(), candidateApproved: z.boolean(),
  issues: z.array(z.string().min(1).max(800)).max(20),
}).strict();

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
  options: z.array(sceneOptionSchema).default([]),
  decisionId: uuidSchema.nullable().default(null),
  published: z.boolean().default(true),
  validation: narrationValidationSchema.nullable().default(null),
  claims: z.array(narrativeClaimSchema).max(40).default([]),
  segments: z.array(narrativeSegmentSchema).max(40).default([]),
  stageId: uuidSchema.nullable().default(null),
}).strict();
export type Scene = z.infer<typeof sceneSchema>;

export const turnSourceSchema = z.enum(['web', 'codex', 'autoplay', 'test']);
export const turnStatusSchema = z.enum(['queued', 'assembling', 'directing', 'reviewing', 'repairing', 'committing', 'narrating', 'summarizing', 'completed', 'waiting_player', 'failed']);
export type TurnStatus = z.infer<typeof turnStatusSchema>;
export const turnStepNameSchema = z.enum(['assembling', 'directing', 'continuity', 'stage', 'agency', 'character', 'pack', 'repairing', 'committing', 'narrating', 'polishing', 'verifying', 'narration_repair', 'summarizing', 'combined', 'resources', 'npc']);
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
  decisionId: uuidSchema.nullable().default(null),
  continuationTurnId: uuidSchema.nullable().default(null),
}).strict();
export type StoryTurn = z.infer<typeof storyTurnSchema>;

export const autoplayRequestSchema = z.object({ durationMinutes: z.number().int().min(60).max(43200), maxScenes: z.number().int().min(1).max(50).default(50) }).strict();
export type AutoplayRequest = z.infer<typeof autoplayRequestSchema>;
export const autoplaySessionSchema = autoplayRequestSchema.extend({ id: uuidSchema, storyId: uuidSchema, startTime: z.number().int().min(0), targetTime: z.number().int().min(1), scenes: z.number().int().min(0), status: z.enum(['running', 'paused', 'completed', 'stopped']), pauseReason: z.string().max(800).nullable() });
export type AutoplaySession = z.infer<typeof autoplaySessionSchema>;

export const createStoryRequestSchema = z.object({ config: storyWorldConfigSchema, seed: z.number().int().min(1).max(2147483647).optional() }).strict();
export const createTurnRequestSchema = z.object({ input: z.string().trim().min(1).max(4000), source: turnSourceSchema.default('web'), idempotencyKey: z.string().min(8).max(120), sceneId: uuidSchema.optional(), optionId: idSchema.optional(), resourceIntent: resourceIntentSchema.optional() }).strict();
export const resolveChoiceRequestSchema = z.object({ decisionId: uuidSchema.optional(), optionId: idSchema.optional(), choice: z.string().trim().min(1).max(4000).optional(), idempotencyKey: z.string().min(8).max(120).optional(), source: turnSourceSchema.default('web') }).strict();
export type ResolveChoiceRequest = z.infer<typeof resolveChoiceRequestSchema>;
export const deadlineRequestSchema = z.object({ revision: z.number().int().positive(), action: z.enum(['extend', 'close']), deadlineMinutes: z.number().int().positive().optional(), idempotencyKey: z.string().min(8).max(120) }).strict();
export type DeadlineRequest = z.infer<typeof deadlineRequestSchema>;

export interface StoryStateView {
  id: string; branch: string; title: string; status: 'draft' | 'active' | 'archived' | 'finished'; clock: number; revision: number;
  config: StoryWorldConfig; outline: OutlineDraft | null; arc: { objective: string; stakes: string } | null;
  activeStage: StoryStage | null; stages: StoryStage[]; characters: Character[]; relationships: Relationship[];
  scenes: Scene[]; facts: CanonicalFact[]; latestTurn: StoryTurn | null; autoplay: AutoplaySession | null;
  schemaVersion: number; pendingDecision: StoryDecision | null;
}
