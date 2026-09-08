import { experienceStateSchema } from '../contracts/experience.ts';
import { NpcStore } from './npc-store.ts';
import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import {
  autoplaySessionSchema, characterSchema, factSchema, narrationSchema, outlineDraftSchema, relationshipSchema,
  scenePlanSchema, sceneSchema, storyStageSchema, storyTurnSchema, storyWorldConfigSchema,
  type AgentReview, type AutoplayRequest, type AutoplaySession, type CanonicalFact, type Character, type Narration,
  type OutlineDraft, type Relationship, type Scene, type ScenePlan, type StoryStage, type StoryStateView,
  type StoryTurn, type StoryWorldConfig, type TurnStatus,
  decisionSchema, resolveChoiceRequestSchema, deadlineRequestSchema, stageReviewSchema,
  type StoryDecision, type ResolveChoiceRequest, type DeadlineRequest, type StageReview, type NarrationValidation,
} from '../contracts/index.ts';
import type { Database } from './database.ts';
import { migrateV2, sceneOptions } from './migrations.ts';
import { initializeMilestones, stageProgress, isMilestoneEvidence, majorChangeIndices } from './stages.ts';
import { StoryConflict } from './errors.ts';
import { ExperienceStore, CURRENT_SCHEMA_VERSION, digest } from './experience-store.ts';
import { distribution } from '../agent-runtime/observability.ts';
import { validateGraph, eligibleRoutes } from './branches.ts';
import { ResourceStore } from './resource-store.ts';
import type { ResourceIntent } from '../contracts/experience.ts';
import type { ExperienceState, StoryThread, MemoryHit } from '../contracts/experience.ts';

export interface StoryScope { storyId: string; owner?: string }
export interface RuntimeContext {
  config: StoryWorldConfig; stage: StoryStage | null; characters: Character[]; facts: CanonicalFact[]; scenes: Scene[];
  autoplay: AutoplaySession | null; clock: number; revision: number; promptVersion: number; outline: OutlineDraft;
  arc: { objective: string; stakes: string }; relationships: Relationship[]; evidenceFacts: CanonicalFact[];
  previousStages: StoryStage[]; confirmedDecision?: StoryDecision | null;
  experience?: ExperienceState; relevantFacts?: CanonicalFact[]; threads?: StoryThread[]; memoryHits?: MemoryHit[];
}

const parseFact = (row: any) => factSchema.parse({ id: row.id, seq: Number(row.seq), time: Number(row.time), kind: row.kind, text: row.text, tags: row.tags, visibility: row.visibility, sourceTurnId: row.source_turn_id, payload: row.payload });

const processing = ['assembling', 'directing', 'reviewing', 'repairing', 'committing', 'narrating', 'summarizing'];

export class StoryStore {
  private outboxFlushPromise: Promise<void> | null = null;
  readonly experience: ExperienceStore;
  readonly resources: ResourceStore; readonly npcs: NpcStore;
  constructor(public database: Database) { this.experience = new ExperienceStore(database); this.resources = new ResourceStore(this); this.npcs = new NpcStore(this); }

  async setup() {
    await this.database.pool.query(`
      CREATE TABLE IF NOT EXISTS stories(
        id uuid PRIMARY KEY, branch text NOT NULL, owner text NOT NULL, title text NOT NULL,
        config jsonb NOT NULL, outline jsonb, arc jsonb, status text NOT NULL,
        clock bigint NOT NULL DEFAULT 0, revision integer NOT NULL DEFAULT 1,
        active_stage_id uuid, fact_seq integer NOT NULL DEFAULT 0, running_turn_id uuid,
        prompt_version integer NOT NULL DEFAULT 1, seed integer NOT NULL,
        created_at bigint NOT NULL, updated_at bigint NOT NULL
      );
      CREATE INDEX IF NOT EXISTS stories_owner_idx ON stories(owner,updated_at DESC);
      CREATE TABLE IF NOT EXISTS prompt_revisions(id uuid PRIMARY KEY,story_id uuid NOT NULL REFERENCES stories(id) ON DELETE CASCADE,version integer NOT NULL,config jsonb NOT NULL,created_at bigint NOT NULL,UNIQUE(story_id,version));
      CREATE TABLE IF NOT EXISTS story_stages(id uuid PRIMARY KEY,story_id uuid NOT NULL REFERENCES stories(id) ON DELETE CASCADE,position integer NOT NULL,data jsonb NOT NULL,UNIQUE(story_id,position));
      CREATE TABLE IF NOT EXISTS characters(story_id uuid NOT NULL REFERENCES stories(id) ON DELETE CASCADE,id text NOT NULL,data jsonb NOT NULL,PRIMARY KEY(story_id,id));
      CREATE TABLE IF NOT EXISTS relationships(id uuid PRIMARY KEY,story_id uuid NOT NULL REFERENCES stories(id) ON DELETE CASCADE,from_id text NOT NULL,to_id text NOT NULL,data jsonb NOT NULL,UNIQUE(story_id,from_id,to_id));
      CREATE TABLE IF NOT EXISTS story_turns(
        id uuid PRIMARY KEY,story_id uuid NOT NULL REFERENCES stories(id) ON DELETE CASCADE,source text NOT NULL,input text NOT NULL,
        idempotency_key text NOT NULL,status text NOT NULL,current_step text NOT NULL DEFAULT '',context jsonb,plan jsonb,reviews jsonb,
        error text,waiting_reason text,created_at bigint NOT NULL,updated_at bigint NOT NULL,UNIQUE(story_id,idempotency_key)
      );
      CREATE INDEX IF NOT EXISTS story_turns_story_idx ON story_turns(story_id,created_at DESC);
      CREATE TABLE IF NOT EXISTS turn_steps(id uuid PRIMARY KEY,turn_id uuid NOT NULL REFERENCES story_turns(id) ON DELETE CASCADE,name text NOT NULL,agent_role text NOT NULL,status text NOT NULL,summary text NOT NULL DEFAULT '',started_at bigint NOT NULL,completed_at bigint);
      CREATE TABLE IF NOT EXISTS facts(id uuid PRIMARY KEY,story_id uuid NOT NULL REFERENCES stories(id) ON DELETE CASCADE,seq integer NOT NULL,time bigint NOT NULL,kind text NOT NULL,text text NOT NULL,tags text[] NOT NULL,visibility text NOT NULL,source_turn_id uuid NOT NULL,created_at bigint NOT NULL,UNIQUE(story_id,seq));
      ALTER TABLE facts ADD COLUMN IF NOT EXISTS payload jsonb;
      CREATE INDEX IF NOT EXISTS facts_story_idx ON facts(story_id,seq DESC);
      CREATE INDEX IF NOT EXISTS facts_search_idx ON facts USING gin(to_tsvector('simple',text));
      CREATE TABLE IF NOT EXISTS scenes(id uuid PRIMARY KEY,story_id uuid NOT NULL REFERENCES stories(id) ON DELETE CASCADE,turn_id uuid NOT NULL UNIQUE,seq integer NOT NULL,start_time bigint NOT NULL,end_time bigint NOT NULL,data jsonb NOT NULL,created_at bigint NOT NULL,UNIQUE(story_id,seq));
      CREATE TABLE IF NOT EXISTS stage_proposals(id uuid PRIMARY KEY,story_id uuid NOT NULL REFERENCES stories(id) ON DELETE CASCADE,stage_id uuid NOT NULL,status text NOT NULL,reason text NOT NULL,created_at bigint NOT NULL,reviewed_at bigint);
      CREATE TABLE IF NOT EXISTS autoplay_sessions(id uuid PRIMARY KEY,story_id uuid NOT NULL REFERENCES stories(id) ON DELETE CASCADE,data jsonb NOT NULL,created_at bigint NOT NULL,updated_at bigint NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS autoplay_running_idx ON autoplay_sessions(story_id) WHERE data->>'status'='running';
      CREATE TABLE IF NOT EXISTS story_outbox(id uuid PRIMARY KEY,turn_id uuid NOT NULL UNIQUE REFERENCES story_turns(id) ON DELETE CASCADE,dispatched boolean NOT NULL DEFAULT false,created_at bigint NOT NULL);
    `);
    await migrateV2(this.database);
    await this.experience.setup();
  }

  private async assertOwner(storyId: string, owner?: string) {
    const result = await this.database.pool.query('SELECT owner FROM stories WHERE id=$1', [storyId]);
    if (!result.rows.length) throw new Error('STORY_NOT_FOUND');
    if (owner && result.rows[0].owner !== owner) throw new Error('UNAUTHORIZED');
  }

  async create(owner: string, configInput: StoryWorldConfig, seed = Math.floor(Math.random() * 2_000_000_000) + 1) {
    const config = storyWorldConfigSchema.parse(configInput); const id = randomUUID(); const now = Date.now();
    await this.database.pool.query('INSERT INTO stories(id,branch,owner,title,config,status,seed,created_at,updated_at,schema_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8,$9)', [id, 'main', owner, config.title, config, 'draft', seed, now,CURRENT_SCHEMA_VERSION]);
    await this.database.pool.query('INSERT INTO prompt_revisions(id,story_id,version,config,created_at) VALUES($1,$2,1,$3,$4)', [randomUUID(), id, config, now]);
    await this.experience.initialize(this.database.pool, id);
    return { storyId: id, branch: 'main', seed };
  }

  async list(owner: string) {
    const { rows } = await this.database.pool.query('SELECT id,branch,title,status,clock,updated_at FROM stories WHERE owner=$1 ORDER BY updated_at DESC', [owner]);
    return rows.map(row => ({ id: row.id, branch: row.branch, title: row.title, status: row.status, clock: Number(row.clock), updatedAt: Number(row.updated_at) }));
  }

  async config(storyId: string, owner?: string) {
    await this.assertOwner(storyId, owner); const { rows } = await this.database.pool.query('SELECT config,seed,outline FROM stories WHERE id=$1', [storyId]);
    return { config: storyWorldConfigSchema.parse(rows[0].config), seed: Number(rows[0].seed), outline: rows[0].outline ? outlineDraftSchema.parse(rows[0].outline) : null };
  }

  async updateConfig(storyId: string, owner: string, configInput: StoryWorldConfig) {
    await this.assertOwner(storyId, owner); const config = storyWorldConfigSchema.parse(configInput); const client = await this.database.pool.connect();
    try {
      await client.query('BEGIN'); const locked = await client.query('SELECT prompt_version FROM stories WHERE id=$1 FOR UPDATE', [storyId]); const version = Number(locked.rows[0].prompt_version) + 1;
      await client.query('UPDATE stories SET config=$2,title=$3,prompt_version=$4,revision=revision+1,updated_at=$5 WHERE id=$1', [storyId, config, config.title, version, Date.now()]);
      await client.query('INSERT INTO prompt_revisions(id,story_id,version,config,created_at) VALUES($1,$2,$3,$4,$5)', [randomUUID(), storyId, version, config, Date.now()]);
      await this.experience.event(client, storyId, { type: 'config_changed', config, version }, '故事设置已更新');
      if (!(await client.query('SELECT running_turn_id FROM stories WHERE id=$1', [storyId])).rows[0].running_turn_id) await this.experience.checkpoint(client, storyId, '设置更新');
      await client.query('COMMIT');
      return { version };
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }

  async saveOutline(storyId: string, owner: string | undefined, draftInput: OutlineDraft) {
    await this.assertOwner(storyId, owner); const draft = outlineDraftSchema.parse(draftInput);
    validateGraph(draft);
    const saved = await this.database.pool.query('UPDATE stories SET outline=$2,title=$3,revision=revision+1,updated_at=$4 WHERE id=$1 AND status=\'draft\'', [storyId, draft, draft.title, Date.now()]); if (!saved.rowCount) throw new StoryConflict('USE_GRAPH_EDIT'); return draft;
  }

  async confirmOutline(storyId: string, owner?: string, override?: OutlineDraft) {
    await this.assertOwner(storyId, owner); const client = await this.database.pool.connect();
    try {
      await client.query('BEGIN'); const row = await client.query('SELECT outline,status FROM stories WHERE id=$1 FOR UPDATE', [storyId]);
      if (row.rows[0].status !== 'draft') throw new Error('OUTLINE_ALREADY_CONFIRMED');
      const outline = outlineDraftSchema.parse(override ?? row.rows[0].outline); validateGraph(outline);
      const stages: StoryStage[] = outline.stages.map((draft, position) => initializeMilestones(storyStageSchema.parse({ ...draft, id: randomUUID(), position, status: outline.graph ? draft.nodeId === outline.graph.entry ? 'active' : 'planned' : position === 0 ? 'active' : 'planned', progress: 0, revision: 1 })));
      const entry = stages.find(s => s.status === 'active')!;
      if (entry.deadlineMinutes === null && entry.entryBudgetMinutes !== null) entry.deadlineMinutes = entry.entryBudgetMinutes;
      for (const stage of stages) await client.query('INSERT INTO story_stages(id,story_id,position,data) VALUES($1,$2,$3,$4)', [stage.id, storyId, stage.position, stage]);
      const characters = outline.characters.map(character => characterSchema.parse({ ...character, mood: '平静', condition: '状态稳定', currentGoal: character.drives[0] ?? '', recentBeat: '故事尚未开始', unresolvedHooks: [], lastSceneSeq: 0, spotlight: character.importance === 'protagonist' ? 100 : character.importance === 'core' ? 80 : 40, version: 1 }));
      for (const character of characters) await client.query('INSERT INTO characters(story_id,id,data) VALUES($1,$2,$3)', [storyId, character.id, character]);
      const protagonist = characters.find(character => character.importance === 'protagonist')!;
      for (const character of characters.filter(character => character.id !== protagonist.id)) {
        const relation = relationshipSchema.parse({ id: randomUUID(), from: protagonist.id, to: character.id, trust: 0, affinity: 0, tension: 0, summary: '关系将在故事中形成', evidenceFactIds: [], version: 1 });
        await client.query('INSERT INTO relationships(id,story_id,from_id,to_id,data) VALUES($1,$2,$3,$4,$5)', [relation.id, storyId, relation.from, relation.to, relation]);
      }
      await client.query('UPDATE stories SET outline=$2,arc=$3,status=$4,active_stage_id=$5,revision=revision+1,updated_at=$6 WHERE id=$1', [storyId, outline, { objective: outline.arcObjective, stakes: outline.stakes }, 'active', entry.id, Date.now()]);
      await this.addEvent(client, storyId, randomUUID(), 0, 'stage', '故事已建立', ['initialization'], { type: 'story_initialized', stages, activeStageId: entry.id, storyStatus: 'active' }, 'private');
      await this.experience.initialize(client, storyId);
      await this.experience.event(client, storyId, { type: 'experience_initialized', state: await this.experience.state(storyId, client), characters, outline }, '初始世界快照');
      await this.resources.initialize(client,storyId,storyWorldConfigSchema.parse((await client.query('SELECT config FROM stories WHERE id=$1',[storyId])).rows[0].config),characters,outline.startingPanels);
      await this.experience.checkpoint(client, storyId, '开局');
      await client.query('COMMIT');
      return { activeStageId: entry.id };
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }

  async context(storyId: string, input = ''): Promise<RuntimeContext> {
    const client = await this.database.pool.connect();
    try {
      await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      const story = await client.query('SELECT * FROM stories WHERE id=$1', [storyId]); if (!story.rows.length) throw new Error('STORY_NOT_FOUND'); const row = story.rows[0];
      if (!['active', 'finished'].includes(row.status) || !row.outline) throw new Error('STORY_NOT_ACTIVE');
      const stages = await client.query('SELECT data FROM story_stages WHERE story_id=$1 ORDER BY position', [storyId]);
      const characters = await client.query('SELECT data FROM characters WHERE story_id=$1 ORDER BY CASE data->>\'importance\' WHEN \'protagonist\' THEN 0 WHEN \'core\' THEN 1 ELSE 2 END,id', [storyId]);
      const facts = await client.query("SELECT id,seq,time,kind,text,tags,visibility,source_turn_id,payload FROM facts WHERE story_id=$1 AND payload->>'type' IN ('fact','character','relationship','player_choice','autoplay_authorized') ORDER BY seq DESC LIMIT 24", [storyId]);
      const scenes = await client.query('SELECT data FROM scenes WHERE story_id=$1 ORDER BY seq DESC LIMIT 8', [storyId]);
      const autoplay = await client.query('SELECT data FROM autoplay_sessions WHERE story_id=$1 ORDER BY created_at DESC LIMIT 1', [storyId]);
      const relationships = (await client.query('SELECT data FROM relationships WHERE story_id=$1 ORDER BY from_id,to_id', [storyId])).rows.map(value => relationshipSchema.parse(value.data));
      const experience = await this.experience.state(storyId, client);
      const parsedStages = stages.rows.map(value => storyStageSchema.parse(value.data));
      const evidenceIds = [...new Set([...relationships.flatMap(value => value.evidenceFactIds), ...parsedStages.flatMap(stage => [...stage.failureEvidenceFactIds, ...stage.milestones.flatMap(item => item.evidenceFactIds)]),...experience.goals.filter(g=>['pending','warned'].includes(g.status)).flatMap(g=>[...g.evidenceFactIds,...(g.warningFactId?[g.warningFactId]:[])]),...Object.values(experience.assertions).flatMap(a=>a.evidenceFactIds)])];
      const evidence = evidenceIds.length ? (await client.query('SELECT * FROM facts WHERE story_id=$1 AND id=ANY($2::uuid[]) ORDER BY seq', [storyId, evidenceIds])).rows.map(parseFact) : [];
      const cast = characters.rows.map(value => characterSchema.parse(value.data));
      const memory = await this.experience.retrieve(client, storyId, `${input} ${parsedStages.find(s => s.id === row.active_stage_id)?.objective ?? ''}`, cast, facts.rows.map(f => f.id));
      const required={arc:row.arc,stage:parsedStages.find(s=>s.id===row.active_stage_id),relationships,evidence,threads:memory.threads,facts:memory.facts.filter(f=>memory.requiredFactIds.includes(f.id)),recent:facts.rows};
      let size=JSON.stringify(required).length;if(size>80000)throw new StoryConflict('MEMORY_REQUIRED_BUDGET_EXCEEDED');
      memory.facts=memory.facts.filter(f=>{if(memory.requiredFactIds.includes(f.id))return true;size+=JSON.stringify(f).length;return size<=100000;});
      await client.query('COMMIT');
      const recentFacts = facts.rows.reverse().map(parseFact);
      return { config: storyWorldConfigSchema.parse(row.config), stage: parsedStages.find(stage => stage.id === row.active_stage_id) ?? null, characters: cast, facts: recentFacts, evidenceFacts: evidence.filter(item => !recentFacts.some(recent => recent.id === item.id)), relevantFacts: memory.facts.filter(f => !evidenceIds.includes(f.id)), threads: memory.threads, memoryHits: memory.hits, experience, relationships, arc: row.arc, previousStages: parsedStages.filter(stage => ['completed', 'closed', 'failed'].includes(stage.status)), scenes: scenes.rows.reverse().map(value => sceneSchema.parse(value.data)).filter(scene => scene.published), autoplay: autoplay.rows[0] ? autoplaySessionSchema.parse(autoplay.rows[0].data) : null, clock: Number(row.clock), revision: Number(row.revision), promptVersion: Number(row.prompt_version), outline: outlineDraftSchema.parse(row.outline) };
    } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; } finally { client.release(); }
  }

  async state(storyId: string, owner?: string): Promise<StoryStateView> {
    const client = await this.database.pool.connect();
    try {
      await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const story = await client.query('SELECT * FROM stories WHERE id=$1', [storyId]); if (!story.rows.length) throw new Error('STORY_NOT_FOUND'); const row = story.rows[0];
      if (owner && row.owner !== owner) throw new Error('UNAUTHORIZED_STORY');
      const stages = await client.query('SELECT data FROM story_stages WHERE story_id=$1 ORDER BY position', [storyId]);
      const characters = await client.query('SELECT data FROM characters WHERE story_id=$1 ORDER BY CASE data->>\'importance\' WHEN \'protagonist\' THEN 0 WHEN \'core\' THEN 1 ELSE 2 END,id', [storyId]);
      const relationships = await client.query('SELECT data FROM relationships WHERE story_id=$1 ORDER BY from_id,to_id', [storyId]);
      const facts = await client.query("SELECT id,seq,time,kind,text,tags,visibility,source_turn_id,payload FROM facts WHERE story_id=$1 AND visibility<>'private' ORDER BY seq DESC LIMIT 50", [storyId]);
      const scenes = await client.query('SELECT data FROM scenes WHERE story_id=$1 ORDER BY seq DESC LIMIT 30', [storyId]);
      const latestTurn = await client.query("SELECT t.*,(SELECT data->>'continuationTurnId' FROM story_decisions WHERE turn_id=t.id) AS continuation_turn_id FROM story_turns t WHERE story_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1", [storyId]);
      const autoplay = await client.query("SELECT data FROM autoplay_sessions WHERE story_id=$1 ORDER BY created_at DESC LIMIT 1", [storyId]);
      const decisions = await client.query("SELECT d.data FROM story_decisions d JOIN scenes s ON s.id=d.scene_id WHERE d.story_id=$1 AND d.data->>'status'='pending' AND (s.data->>'published')::boolean IS DISTINCT FROM false", [storyId]);
      let parsedTurn: StoryTurn | null = null;
      if (latestTurn.rows[0]) {
        const turnRow = latestTurn.rows[0]; const steps = await client.query('SELECT * FROM turn_steps WHERE turn_id=$1 ORDER BY started_at,id', [turnRow.id]); const scene = await client.query('SELECT data FROM scenes WHERE turn_id=$1', [turnRow.id]);
        parsedTurn = this.parseTurn(turnRow, steps.rows, scene.rows[0]?.data ?? null);
      }
      await client.query('COMMIT'); const parsedStages = stages.rows.map(value => storyStageSchema.parse(value.data));
      return { id: row.id, branch: row.branch, title: row.title, status: row.status, clock: Number(row.clock), revision: Number(row.revision), schemaVersion: Number(row.schema_version), pendingDecision: decisions.rows[0] ? decisionSchema.parse(decisions.rows[0].data) : null, config: storyWorldConfigSchema.parse(row.config), outline: row.outline ? outlineDraftSchema.parse(row.outline) : null, arc: row.arc, activeStage: parsedStages.find(stage => stage.id === row.active_stage_id) ?? null, stages: parsedStages, characters: characters.rows.map(value => characterSchema.parse(value.data)), relationships: relationships.rows.map(value => relationshipSchema.parse(value.data)), scenes: scenes.rows.reverse().map(value => sceneSchema.parse(value.data)).filter(scene => scene.published), facts: facts.rows.reverse().map(parseFact), latestTurn: parsedTurn, autoplay: autoplay.rows[0] ? autoplaySessionSchema.parse(autoplay.rows[0].data) : null };
    } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; } finally { client.release(); }
  }

  private async lockStory(client: PoolClient, storyId: string) {
    const result = await client.query('SELECT * FROM stories WHERE id=$1 FOR UPDATE', [storyId]);
    if (!result.rows[0]) throw new Error('STORY_NOT_FOUND');
    return result.rows[0];
  }

  private async assertAdvance(client: PoolClient, story: any) {
    if (story.status !== 'active') throw new StoryConflict('STORY_NOT_ACTIVE');
    const stage = await client.query('SELECT data FROM story_stages WHERE id=$1', [story.active_stage_id]);
    if (stage.rows[0]?.data.awaitingDeadline) throw new StoryConflict('STAGE_DEADLINE_REQUIRES_REVIEW');
    if ((await client.query("SELECT id FROM stage_proposals WHERE story_id=$1 AND status='pending'", [story.id])).rows.length) throw new StoryConflict('STAGE_PROPOSAL_REQUIRES_REVIEW');
    if (stage.rows[0] && stage.rows[0].data.status !== 'active') throw new StoryConflict('STAGE_REQUIRES_TRANSITION');
  }

  private async pauseManual(client: PoolClient, storyId: string) {
    await client.query("UPDATE autoplay_sessions SET data=jsonb_set(jsonb_set(data,'{status}','\"paused\"'::jsonb),'{pauseReason}',to_jsonb('收到手动输入；执行后保持暂停'::text)),updated_at=$2 WHERE story_id=$1 AND data->>'status'='running'", [storyId, Date.now()]);
    await client.query("UPDATE story_turns SET status='failed',current_step='failed',error='手动输入已取代排队中的托管回合',updated_at=$2 WHERE story_id=$1 AND source='autoplay' AND status='queued'", [storyId, Date.now()]);
  }

  private async insertTurn(client: PoolClient, storyId: string, input: string, source: StoryTurn['source'], key: string, decisionId: string | null = null) {
    const id = randomUUID();
    await client.query('INSERT INTO story_turns(id,story_id,source,input,idempotency_key,status,created_at,updated_at,decision_id) VALUES($1,$2,$3,$4,$5,\'queued\',$6,$6,$7)', [id, storyId, source, input, key, Date.now(), decisionId]);
    await client.query('INSERT INTO story_outbox(id,turn_id,created_at) VALUES($1,$2,$3)', [randomUUID(), id, Date.now()]);
    return id;
  }

  async enqueueTurn(storyId: string, input: string, source: StoryTurn['source'], idempotencyKey: string, option?: { sceneId?: string; optionId?: string; resourceIntent?: ResourceIntent }) {
    const client = await this.database.pool.connect(); let id: string;
    try {
      await client.query('BEGIN'); const story = await this.lockStory(client, storyId);
      const existing = await client.query('SELECT id,input,action_intent FROM story_turns WHERE story_id=$1 AND idempotency_key=$2', [storyId, idempotencyKey]);
      const resolved = await client.query('SELECT response FROM story_requests WHERE story_id=$1 AND key=$2', [storyId, idempotencyKey]);
      if (existing.rows[0]) {
        if (existing.rows[0].input !== input || digest(existing.rows[0].action_intent??null)!==digest(option?.resourceIntent??null)) throw new StoryConflict('IDEMPOTENCY_CONFLICT');
        id = existing.rows[0].id;
      } else if (resolved.rows[0]?.response.continuationTurnId) {
        if (resolved.rows[0].response.choice !== input || digest(resolved.rows[0].response.resourceIntent??null)!==digest(option?.resourceIntent??null)) throw new StoryConflict('IDEMPOTENCY_CONFLICT');
        id = resolved.rows[0].response.continuationTurnId;
      } else {
        await this.assertAdvance(client, story);
        const pending = await client.query("SELECT data FROM story_decisions WHERE story_id=$1 AND data->>'status'='pending'", [storyId]);
        if (pending.rows[0]) {
          if (source === 'autoplay') throw new StoryConflict('PLAYER_CHOICE_REQUIRED');
          const result = await this.resolveInside(client, story, { decisionId: pending.rows[0].data.id, choice: input, idempotencyKey, source });
          id = result.continuationTurnId;
          if(option?.resourceIntent){await client.query('UPDATE story_turns SET action_intent=$2 WHERE id=$1',[id,option.resourceIntent]);await client.query("UPDATE story_requests SET response=response||$3::jsonb WHERE story_id=$1 AND key=$2",[storyId,idempotencyKey,{resourceIntent:option.resourceIntent}]);}
        } else {
          if (option?.sceneId || option?.optionId) {
            const latest = await client.query('SELECT data FROM scenes WHERE story_id=$1 ORDER BY seq DESC LIMIT 1', [storyId]);
            const scene = latest.rows[0] ? sceneSchema.parse(latest.rows[0].data) : null;
            if (!scene?.published || scene.id !== option.sceneId || !scene.options.some(item => item.id === option.optionId && item.text === input)) throw new StoryConflict('STALE_OPTION');
            if ((await client.query('SELECT id FROM story_turns WHERE story_id=$1 AND status=ANY($2::text[])', [storyId, ['queued', ...processing]])).rows.length) throw new StoryConflict('STORY_BUSY');
          }
          if (source !== 'autoplay') await this.pauseManual(client, storyId);
          id = await this.insertTurn(client, storyId, input, source, idempotencyKey);
          if(option?.resourceIntent)await client.query('UPDATE story_turns SET action_intent=$2 WHERE id=$1',[id,option.resourceIntent]);
        }
      }
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    return this.turn(id);
  }

  flushOutbox() {
    if (this.outboxFlushPromise) return this.outboxFlushPromise;
    this.outboxFlushPromise = this.flushOutboxOnce().finally(() => { this.outboxFlushPromise = null; }); return this.outboxFlushPromise;
  }

  private async flushOutboxOnce() {
    const { rows } = await this.database.pool.query('SELECT id,turn_id FROM story_outbox WHERE dispatched=false ORDER BY created_at LIMIT 30');
    for (const row of rows) {
      await this.database.boss.send('story-turn', { turnId: row.turn_id }, { singletonKey: `story-turn:${row.turn_id}` });
      await this.database.pool.query('UPDATE story_outbox SET dispatched=true WHERE id=$1', [row.id]);
    }
  }

  async recoverInterrupted() {
    const client = await this.database.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("UPDATE story_turns SET status='queued',current_step='queued',error=NULL,updated_at=$1 WHERE NOT import_suspended AND status=ANY($2::text[])", [Date.now(), ['assembling', 'directing', 'reviewing', 'repairing', 'committing']]);
      await client.query("UPDATE stories SET running_turn_id=NULL WHERE running_turn_id IN (SELECT id FROM story_turns WHERE status='queued')");
      await client.query("UPDATE story_outbox SET dispatched=false WHERE turn_id IN (SELECT id FROM story_turns WHERE NOT import_suspended AND status IN ('queued','narrating','summarizing'))");
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }

  async requeue(turnId: string) { await this.database.pool.query('UPDATE story_outbox SET dispatched=false WHERE turn_id=$1', [turnId]); }

  async recoverAutoplay() {
    const turns = await this.database.pool.query("SELECT t.id,t.story_id FROM story_turns t WHERE source='autoplay' AND status IN ('completed','waiting_player') AND NOT EXISTS (SELECT 1 FROM story_requests r WHERE r.story_id=t.story_id AND r.key='autoplay-account:' || t.id::text) ORDER BY created_at,id");
    for (const turn of turns.rows) await this.advanceAutoplay(turn.id, turn.story_id);
  }

  async retrySceneNarration(storyId: string, sceneId: string, key: string) {
    const row = (await this.database.pool.query('SELECT turn_id FROM scenes WHERE id=$1 AND story_id=$2', [sceneId, storyId])).rows[0];
    if (!row) throw new Error('SCENE_NOT_FOUND');
    return this.retryTurn(storyId, row.turn_id, key, true);
  }

  async metrics(storyId: string) {
    const scenes = (await this.database.pool.query('SELECT data FROM scenes WHERE story_id=$1', [storyId])).rows.map(row => sceneSchema.parse(row.data)).filter(scene => scene.published);
    const checked = scenes.filter(scene => scene.validation);
    const timings = (await this.database.pool.query('SELECT s.name,count(*)::int AS calls,avg(s.completed_at-s.started_at)::float AS average_ms FROM turn_steps s JOIN story_turns t ON t.id=s.turn_id WHERE t.story_id=$1 AND s.completed_at IS NOT NULL GROUP BY s.name', [storyId])).rows;
    const observations = (await this.database.pool.query('SELECT * FROM turn_observations WHERE story_id=$1 ORDER BY started_at', [storyId])).rows;
    const stepRows = (await this.database.pool.query('SELECT s.name,s.completed_at-s.started_at AS duration FROM turn_steps s JOIN story_turns t ON t.id=s.turn_id WHERE t.story_id=$1 AND s.completed_at IS NOT NULL', [storyId])).rows;
    const phases = Object.fromEntries([...new Set(stepRows.map(s => s.name))].map(name => [name, distribution(stepRows.filter(s => s.name === name).map(s => Number(s.duration)))]));
    const models = observations.filter(o => o.name.startsWith('model:'));
    const runs = observations.filter(o => o.name === 'run' && o.completed_at);
    const byAttempt=Object.fromEntries(['first','retry','narration_recovery'].map(kind=>[kind,distribution(runs.filter(r=>(r.data.attemptKind??'first')===kind).map(r=>Number(r.completed_at)-Number(r.started_at)))]));
    return { latency: { byAttempt, phases, total: distribution(runs.map(r => Number(r.completed_at)-Number(r.started_at))), queue: distribution(runs.map(r => r.data.queueMs)), firstPublication: distribution(observations.filter(o => o.name === 'publication').map(o => o.data.elapsedMs)) }, modelUsage: { calls: models.length, reportedRequests: models.reduce((sum,o) => sum + Number(o.data.requests ?? 1),0), tokensKnown: models.length > 0 && models.every(o => o.data.usageKnown), inputTokens: models.every(o => o.data.usageKnown) ? models.reduce((sum,o) => sum + Number(o.data.inputTokens ?? 0),0) : null, outputTokens: models.every(o => o.data.usageKnown) ? models.reduce((sum,o) => sum + Number(o.data.outputTokens ?? 0),0) : null }, scenes: scenes.length, checkedScenes: checked.length, semanticReviewRate: checked.length ? checked.filter(scene => scene.validation!.semanticCalls > 0).length / checked.length : 0, fallbackRate: checked.length ? checked.filter(scene => scene.validation!.mode === 'fallback').length / checked.length : 0, semanticCalls: checked.reduce((total, scene) => total + scene.validation!.semanticCalls, 0), steps: timings };
  }

  async runtimeData(turnId: string) {
    const { rows } = await this.database.pool.query('SELECT * FROM story_turns WHERE id=$1', [turnId]);
    if (!rows.length) throw new Error('TURN_NOT_FOUND');
    return { storyId: rows[0].story_id as string, source: rows[0].source as StoryTurn['source'], input: rows[0].input as string, status: rows[0].status as TurnStatus, context: rows[0].context, plan: rows[0].plan, reviews: rows[0].reviews, waitingReason: rows[0].waiting_reason as string | null, decisionId: rows[0].decision_id as string | null, narrationState: rows[0].narration_state as any, narrationRetry: !!rows[0].narration_retry, actionIntent: rows[0].action_intent as ResourceIntent | null, resumeStatus: rows[0].resume_status as TurnStatus | null };
  }

  async turn(turnId: string): Promise<StoryTurn> {
    const client = await this.database.pool.connect();
    try {
      const turn = await client.query("SELECT t.*,(SELECT data->>'continuationTurnId' FROM story_decisions WHERE turn_id=t.id) AS continuation_turn_id FROM story_turns t WHERE id=$1", [turnId]); if (!turn.rows.length) throw new Error('TURN_NOT_FOUND');
      const steps = await client.query('SELECT * FROM turn_steps WHERE turn_id=$1 ORDER BY started_at,id', [turnId]); const scene = await client.query('SELECT data FROM scenes WHERE turn_id=$1', [turnId]);
      return this.parseTurn(turn.rows[0], steps.rows, scene.rows[0]?.data ?? null);
    } finally { client.release(); }
  }

  private parseTurn(row: any, steps: any[], scene: unknown): StoryTurn {
    return storyTurnSchema.parse({ id: row.id, storyId: row.story_id, source: row.source, input: row.input, status: row.status, currentStep: row.current_step, createdAt: Number(row.created_at), updatedAt: Number(row.updated_at), waitingReason: row.waiting_reason, error: row.error, decisionId: row.decision_id ?? (scene ? sceneSchema.parse(scene).decisionId : null), continuationTurnId: row.continuation_turn_id ?? null, scene: scene && sceneSchema.parse(scene).published ? scene : null, steps: steps.filter(step => step?.id).map(step => ({ id: step.id, name: step.name, agentRole: step.agent_role, status: step.status, summary: step.summary, startedAt: Number(step.started_at), completedAt: step.completed_at === null ? null : Number(step.completed_at) })) });
  }

  async claim(turnId: string) {
    const client = await this.database.pool.connect();
    try {
      await client.query('BEGIN'); const lookup = await client.query('SELECT story_id FROM story_turns WHERE id=$1', [turnId]);
      if (!lookup.rows[0]) { await client.query('ROLLBACK'); return null; }
      const story = await this.lockStory(client, lookup.rows[0].story_id);
      const turn = await client.query('SELECT story_id,status,created_at,decision_id FROM story_turns WHERE id=$1 AND NOT import_suspended FOR UPDATE', [turnId]); if (!turn.rows.length || !['queued', 'narrating', 'summarizing'].includes(turn.rows[0].status)) { await client.query('ROLLBACK'); return null; }
      if (story.running_turn_id && story.running_turn_id !== turnId) { await client.query('ROLLBACK'); return { busy: true as const, storyId: turn.rows[0].story_id as string, phase: turn.rows[0].status as TurnStatus }; }
      if (turn.rows[0].status === 'queued') {
        try { await this.assertAdvance(client, story); } catch (error) {
          if (!(error instanceof StoryConflict)) throw error;
          if (story.status === 'finished') await client.query("UPDATE story_turns SET status='failed',error='STORY_FINISHED',updated_at=$2 WHERE id=$1", [turnId, Date.now()]);
          await client.query('COMMIT'); return null;
        }
        if ((await client.query("SELECT id FROM story_decisions WHERE story_id=$1 AND data->>'status'='pending'", [story.id])).rows.length) { await client.query('COMMIT'); return null; }
        const earlier = await client.query("SELECT id FROM story_turns WHERE story_id=$1 AND status='queued' AND ((decision_id IS NULL)::int,created_at,id)<($4::int,$2,$3::uuid) LIMIT 1", [story.id, turn.rows[0].created_at, turnId, turn.rows[0].decision_id ? 0 : 1]);
        if (earlier.rows.length) { await client.query('ROLLBACK'); return { busy: true as const, storyId: story.id as string, phase: 'queued' as TurnStatus }; }
      }
      await client.query("UPDATE stories SET running_turn_id=$2 WHERE id=$1", [turn.rows[0].story_id, turnId]);
      if (turn.rows[0].status === 'queued') await client.query("UPDATE story_turns SET status='assembling',current_step='assembling',updated_at=$2 WHERE id=$1", [turnId, Date.now()]);
      await client.query('COMMIT'); return { busy: false as const, storyId: turn.rows[0].story_id as string, phase: turn.rows[0].status as TurnStatus };
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }

  async setTurnStatus(turnId: string, status: TurnStatus, currentStep = status) { await this.database.pool.query('UPDATE story_turns SET status=$2,current_step=$3,updated_at=$4 WHERE id=$1', [turnId, status, currentStep, Date.now()]); }
  async setTurnData(turnId: string, field: 'context' | 'plan' | 'reviews', data: unknown) { await this.database.pool.query(`UPDATE story_turns SET ${field}=$2::jsonb,updated_at=$3 WHERE id=$1`, [turnId, JSON.stringify(data), Date.now()]); }
  async startStep(turnId: string, name: string, agentRole: string) { const id = randomUUID(); await this.database.pool.query('INSERT INTO turn_steps(id,turn_id,name,agent_role,status,started_at) VALUES($1,$2,$3,$4,$5,$6)', [id, turnId, name, agentRole, 'running', Date.now()]); return id; }
  async finishStep(id: string, summary: string, failed = false) { await this.database.pool.query('UPDATE turn_steps SET status=$2,summary=$3,completed_at=$4 WHERE id=$1', [id, failed ? 'failed' : 'completed', summary.slice(0, 800), Date.now()]); }

  async failTurn(turnId: string, message: string) {
    await this.database.pool.query("UPDATE story_turns SET status='failed',current_step='failed',error=$2,updated_at=$3 WHERE id=$1", [turnId, message.slice(0, 1200), Date.now()]);
    await this.database.pool.query('UPDATE stories SET running_turn_id=NULL WHERE running_turn_id=$1', [turnId]);
  }

  async recordRecoverableError(turnId: string, message: string) {
    await this.database.pool.query('UPDATE story_turns SET error=$2,updated_at=$3 WHERE id=$1', [turnId, message.slice(0, 1200), Date.now()]);
    await this.database.pool.query('UPDATE stories SET running_turn_id=NULL WHERE running_turn_id=$1', [turnId]);
  }

  private async resolveInside(client: PoolClient, story: any, request: ResolveChoiceRequest): Promise<{ decisionId: string; turnId: string; factId: string; choice: string; continuationTurnId: string }> {
    if (request.idempotencyKey) {
      const previous = await client.query('SELECT response FROM story_requests WHERE story_id=$1 AND key=$2', [story.id, request.idempotencyKey]);
      if (previous.rows[0]) {
        const response = previous.rows[0].response;
        if ((request.decisionId && request.decisionId !== response.decisionId) || (request.choice && request.choice !== response.choice) || (request.optionId && request.optionId !== response.optionId)) throw new StoryConflict('IDEMPOTENCY_CONFLICT');
        return response;
      }
    }
    const found = request.decisionId
      ? await client.query('SELECT data FROM story_decisions WHERE id=$1 AND story_id=$2', [request.decisionId, story.id])
      : await client.query("SELECT data FROM story_decisions WHERE story_id=$1 AND data->>'status'='pending'", [story.id]);
    if (found.rows.length !== 1) throw new StoryConflict('CHOICE_ID_REQUIRED_OR_STALE');
    const decision = decisionSchema.parse(found.rows[0].data);
    const option = request.optionId ? decision.options.find(item => item.id === request.optionId) : null;
    if (request.optionId && !option) throw new StoryConflict('STALE_OPTION');
    if (option && request.choice && option.text !== request.choice) throw new StoryConflict('CHOICE_CONFLICT');
    const choice = option?.text ?? request.choice;
    if (!choice) throw new StoryConflict('CHOICE_REQUIRED');
    if (decision.status === 'resolved') {
      if (decision.choice !== choice || !decision.continuationTurnId) throw new StoryConflict('CHOICE_ALREADY_RESOLVED');
      const fact = await client.query("SELECT id FROM facts WHERE story_id=$1 AND payload->>'decisionId'=$2 AND payload->>'type'='player_choice'", [story.id, decision.id]);
      return { decisionId: decision.id, turnId: decision.turnId, factId: fact.rows[0].id, choice, continuationTurnId: decision.continuationTurnId };
    }
    if (decision.status !== 'pending' || decision.stageId !== story.active_stage_id) throw new StoryConflict('STALE_DECISION');
    await this.assertAdvance(client, story);
    if (story.running_turn_id) throw new StoryConflict('STORY_BUSY');
    const scene = await client.query('SELECT data FROM scenes WHERE id=$1', [decision.sceneId]);
    if (!scene.rows[0]?.data.published) throw new StoryConflict('SCENE_NOT_PUBLISHED');
    await this.pauseManual(client, story.id);
    const continuationTurnId = await this.insertTurn(client, story.id, choice, request.source === 'autoplay' ? 'web' : request.source, `decision:${decision.id}`, decision.id);
    const factId = await this.addEvent(client, story.id, decision.turnId, Number(story.clock), 'action', `玩家选择：${choice}`, ['player_choice'], { type: 'player_choice', decisionId: decision.id, sceneId: decision.sceneId, optionId: option?.id ?? null, choice, continuationTurnId });
    decision.status = 'resolved'; decision.choice = choice; decision.selectedOptionId = option?.id ?? null; decision.continuationTurnId = continuationTurnId;
    await client.query('UPDATE story_decisions SET data=$2 WHERE id=$1', [decision.id, decision]);
    await client.query("UPDATE story_turns SET status='completed',current_step='completed',waiting_reason=NULL,updated_at=$2 WHERE id=$1", [decision.turnId, Date.now()]);
    await client.query('UPDATE stories SET revision=revision+1,updated_at=$2 WHERE id=$1', [story.id, Date.now()]);
    const result = { decisionId: decision.id, turnId: decision.turnId, factId, choice, continuationTurnId, optionId: option?.id ?? null };
    if (request.idempotencyKey) await client.query('INSERT INTO story_requests(story_id,key,response) VALUES($1,$2,$3)', [story.id, request.idempotencyKey, result]);
    await client.query("UPDATE story_outbox SET dispatched=false WHERE turn_id IN (SELECT id FROM story_turns WHERE story_id=$1 AND status='queued')", [story.id]);
    return result;
  }

  async resolveChoice(storyId: string, input: string | ResolveChoiceRequest) {
    const request = resolveChoiceRequestSchema.parse(typeof input === 'string' ? { choice: input } : input);
    const client = await this.database.pool.connect();
    try { await client.query('BEGIN'); const story = await this.lockStory(client, storyId); const result = await this.resolveInside(client, story, request); await client.query('COMMIT'); return result; }
    catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }

  async decision(id: string) {
    const result = await this.database.pool.query('SELECT data FROM story_decisions WHERE id=$1', [id]);
    return result.rows[0] ? decisionSchema.parse(result.rows[0].data) : null;
  }

  private async addEvent(client: PoolClient, storyId: string, sourceId: string, time: number, kind: CanonicalFact['kind'], text: string, tags: string[], payload: Record<string, unknown>, visibility: CanonicalFact['visibility'] = 'player') {
    const id = randomUUID(); const seq = await this.nextFact(client, storyId);
    await client.query('INSERT INTO facts(id,story_id,seq,time,kind,text,tags,visibility,source_turn_id,payload,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)', [id, storyId, seq, time, kind, text.slice(0, 1200), tags, visibility, sourceId, payload, Date.now()]);
    return id;
  }

  private async nextFact(client: PoolClient, storyId: string) { const result = await client.query('UPDATE stories SET fact_seq=fact_seq+1 WHERE id=$1 RETURNING fact_seq', [storyId]); return Number(result.rows[0].fact_seq); }

  private async saveStage(client: PoolClient, storyId: string, stage: StoryStage, sourceId: string, time: number, event: string) {
    await client.query('UPDATE story_stages SET data=$2 WHERE id=$1', [stage.id, stage]);
    const story = await client.query('SELECT active_stage_id,status FROM stories WHERE id=$1', [storyId]);
    const decisionStatuses = (await client.query("SELECT id,data->>'status' AS status FROM story_decisions WHERE story_id=$1", [storyId])).rows;
    return this.addEvent(client, storyId, sourceId, time, 'stage', `阶段“${stage.title}”：${event}；已达成 ${stage.milestones.filter(item => item.status === 'achieved').length}/${stage.milestones.length} 项。`, ['stage', stage.id], { type: 'stage_snapshot', event, stage, decisionStatuses, activeStageId: story.rows[0].active_stage_id, storyStatus: story.rows[0].status });
  }

  private async settleStage(client: PoolClient, storyId: string, stage: StoryStage, outcome: NonNullable<StoryStage['outcome']>) {
    stage.outcome = outcome; stage.status = outcome === 'success' ? 'completed' : outcome === 'failure' ? 'failed' : 'closed'; stage.awaitingDeadline = false;
    const story = (await client.query('SELECT outline FROM stories WHERE id=$1',[storyId])).rows[0];
    const outline = outlineDraftSchema.parse(story.outline);
    const all = (await client.query('SELECT id,data FROM story_stages WHERE story_id=$1 ORDER BY position',[storyId])).rows;
    const routes = outline.graph && !stage.terminal ? eligibleRoutes(outline.graph,stage,await this.experience.state(storyId,client)) : [];
    const next = outline.graph ? stage.terminal ? [] : routes.map(route => ({ row: all.find(row=>row.data.nodeId===route.to), route })) : all.filter(row=>row.data.position===stage.position+1).map(row=>({row,route:null}));
    if(outline.graph && !stage.terminal && !next.length)throw new StoryConflict('NO_STAGE_ROUTE');
    for(const {row,route} of next){
      if(!row)throw new StoryConflict('UNKNOWN_ROUTE_TARGET');
      const pending=await client.query("SELECT id FROM stage_proposals WHERE story_id=$1 AND stage_id=$2 AND status='pending'",[storyId,row.id]);
      if(!pending.rows.length)await client.query("INSERT INTO stage_proposals(id,story_id,stage_id,status,reason,created_at,route_id,graph_revision) VALUES($1,$2,$3,'pending',$4,$5,$6,$7)",[randomUUID(),storyId,row.id,`阶段“${stage.title}”以 ${outcome} 结算（${stage.progress}%）；${route?.label ?? '继续下一阶段'}。未解决：${stage.milestones.filter(m=>m.status==='pending').map(m=>m.criterion).join('；') || '无'}`,Date.now(),route?.id ?? null,outline.graph?.revision ?? null]);
    }
    if(!next.length)await client.query("UPDATE stories SET status='finished' WHERE id=$1",[storyId]);
    await client.query(`UPDATE story_decisions SET data=jsonb_set(data,'{status}','"superseded"'::jsonb) WHERE story_id=$1 AND data->>'status'='pending'`,[storyId]);
    await client.query("UPDATE autoplay_sessions SET data=jsonb_set(jsonb_set(data,'{status}',to_jsonb($2::text)),'{pauseReason}',to_jsonb('阶段已结算'::text)),updated_at=$3 WHERE story_id=$1 AND data->>'status' IN ('running','paused')",[storyId,next.length?'paused':'completed',Date.now()]);
  }

  async commitScene(turnId: string, planInput: ScenePlan, assessment?: { stage?: StageReview; authorizedChangeIndices?: number[] }) {
    const plan = scenePlanSchema.parse(planInput); const client = await this.database.pool.connect();
    try {
      await client.query('BEGIN');
      const lookup = await client.query('SELECT story_id FROM story_turns WHERE id=$1', [turnId]); if (!lookup.rows[0]) throw new Error('TURN_NOT_FOUND');
      const story = await this.lockStory(client, lookup.rows[0].story_id); const storyId = story.id as string;
      const turn = (await client.query('SELECT * FROM story_turns WHERE id=$1 FOR UPDATE', [turnId])).rows[0];
      const prior = await client.query('SELECT data FROM scenes WHERE turn_id=$1', [turnId]);
      if (prior.rows[0]) { await client.query('COMMIT'); return { scene: sceneSchema.parse(prior.rows[0].data), waiting: !!turn.waiting_reason, reason: turn.waiting_reason, stageTransition: false }; }
      if (story.running_turn_id !== turnId) throw new StoryConflict('TURN_NOT_CLAIMED');
      await this.assertAdvance(client, story);
      const stageRow = (await client.query('SELECT data FROM story_stages WHERE id=$1', [story.active_stage_id])).rows[0];
      const stage = stageRow ? storyStageSchema.parse(stageRow.data) : null;
      const expected = turn.context;
      if (expected && (expected.promptVersion !== Number(story.prompt_version) || expected.stageId !== story.active_stage_id || expected.stageRevision !== stage?.revision || expected.revision !== Number(story.revision))) throw new StoryConflict('STALE_CONTEXT');
      const npcIndices = await this.npcs.permittedIndices(client,storyId,turnId,plan);
      const criticalIndices = majorChangeIndices(plan).filter(index=>!npcIndices.includes(index));
      if (criticalIndices.length) {
        const decision = turn.decision_id ? (await client.query('SELECT data FROM story_decisions WHERE id=$1 AND story_id=$2', [turn.decision_id, storyId])).rows[0]?.data : null;
        if (!decision || decision.status !== 'resolved' || decision.continuationTurnId !== turnId || criticalIndices.some(index => !assessment?.authorizedChangeIndices?.includes(index))) throw new StoryConflict('UNAUTHORIZED_MAJOR_CHANGE');
      }
      const startTime = Number(story.clock), endTime = startTime + plan.durationMinutes;
      if (stage?.deadlineMinutes !== null && stage?.deadlineMinutes !== undefined && endTime > stage.deadlineMinutes) throw new StoryConflict('STAGE_DEADLINE_EXCEEDED');
      await this.resources.commit(client,storyId,turnId,plan);
      const characters = new Map((await client.query('SELECT id,data FROM characters WHERE story_id=$1', [storyId])).rows.map(row => [row.id, characterSchema.parse(row.data)]));
      const factIds: string[] = [], changeFacts: CanonicalFact[] = [];
      for (const change of plan.changes) {
        let factId: string;
        if (change.type === 'character') {
          const character = characters.get(change.characterId); if (!character) throw new Error(`UNKNOWN_CHARACTER:${change.characterId}`);
          if (change.field === 'hook') character.unresolvedHooks = [...new Set([...character.unresolvedHooks, change.value])].slice(-12); else character[change.field] = change.value;
          character.lastSceneSeq += 1; character.version += 1;
          await client.query('UPDATE characters SET data=$3 WHERE story_id=$1 AND id=$2', [storyId, character.id, character]);
          factId = await this.addEvent(client, storyId, turnId, endTime, 'character', `${character.name}：${change.value}`, ['character', character.id, change.field], { type: 'character', change });
        } else if (change.type === 'relationship') {
          if (!characters.has(change.from) || !characters.has(change.to)) throw new StoryConflict('UNKNOWN_RELATIONSHIP_CHARACTER');
          const found = await client.query('SELECT id,data FROM relationships WHERE story_id=$1 AND ((from_id=$2 AND to_id=$3) OR (from_id=$3 AND to_id=$2))', [storyId, change.from, change.to]);
          const relation = found.rows[0] ? relationshipSchema.parse(found.rows[0].data) : relationshipSchema.parse({ id: randomUUID(), from: change.from, to: change.to, trust: 0, affinity: 0, tension: 0, summary: '', evidenceFactIds: [], version: 1 });
          relation[change.dimension] = Math.max(change.dimension === 'tension' ? 0 : -100, Math.min(100, relation[change.dimension] + change.delta));
          relation.summary = change.reason; relation.version += 1;
          factId = await this.addEvent(client, storyId, turnId, endTime, 'relationship', change.reason, ['relationship', change.from, change.to], { type: 'relationship', change });
          relation.evidenceFactIds = [...relation.evidenceFactIds, factId].slice(-30);
          if (found.rows[0]) await client.query('UPDATE relationships SET data=$2 WHERE id=$1', [relation.id, relation]);
          else await client.query('INSERT INTO relationships(id,story_id,from_id,to_id,data) VALUES($1,$2,$3,$4,$5)', [relation.id, storyId, relation.from, relation.to, relation]);
        } else factId = await this.addEvent(client, storyId, turnId, endTime, change.kind, change.text, change.tags, { type: 'fact', change, observation: plan.observations.find(o=>o.changeIndex===plan.changes.indexOf(change))??null });
        factIds.push(factId);
        changeFacts.push(parseFact((await client.query('SELECT * FROM facts WHERE id=$1', [factId])).rows[0]));
      }
      await this.npcs.commit(client,storyId,turnId,plan,changeFacts,assessment?.stage,endTime);
      // A scene objective is metadata, not evidence that the objective was attained.
      if (plan.memoryAnnotations.length || assessment?.stage?.threadUpdates.length) {
        await this.experience.indexFacts(client, storyId, [...characters.values()]);
        await this.experience.applyMemory(client, storyId, { annotations: plan.memoryAnnotations, threads: assessment?.stage?.threadUpdates ?? [] }, changeFacts, true);
      }
      factIds.push(await this.addEvent(client, storyId, turnId, endTime, 'action', plan.objective, ['scene', ...plan.participants], { type: 'scene_action', objective: plan.objective, participants: plan.participants }));
      let stageTransition = false;
      if (stage) {
        const review = stageReviewSchema.parse(assessment?.stage ?? { approved: true, summary: '无里程碑判定', issues: [] });
        const resolveEvidence = async (refs: StageReview['milestones'][number]['evidence']) => {
          const ids: string[] = [];
          for (const ref of refs) {
            const fact = ref.type === 'change' ? changeFacts[ref.index] : (await client.query('SELECT * FROM facts WHERE id=$1 AND story_id=$2', [ref.factId, storyId])).rows.map(parseFact)[0];
            if (!fact || !isMilestoneEvidence(fact)) throw new StoryConflict('INVALID_MILESTONE_EVIDENCE');
            ids.push(fact.id);
          }
          return [...new Set(ids)];
        };
        if (review.assertions.length) {
          const experience = await this.experience.state(storyId,client);
          const definitions = outlineDraftSchema.parse(story.outline).assertionDefinitions;
          for (const assertion of review.assertions) {
            if (!definitions.some(d=>d.key===assertion.key)) throw new StoryConflict('UNKNOWN_BRANCH_ASSERTION');
            const evidence = await resolveEvidence(assertion.evidence);
            const evidenceRows = (await client.query('SELECT * FROM facts WHERE story_id=$1 AND id=ANY($2::uuid[])',[storyId,evidence])).rows.map(parseFact);
            if(evidenceRows.some(f=>f.kind==='dialogue'||/可能|据说|声称|猜测|未确认/.test(f.text)))throw new StoryConflict('ASSERTION_REQUIRES_CONFIRMED_EVENT');
            experience.assertions[assertion.key]={value:assertion.value,evidenceFactIds:evidence};
          }
          await this.experience.save(client,storyId,experience,'分支事实已核验',turnId);
        }
        let changed = false;
        for (const evaluation of review.milestones) {
          const milestone = stage.milestones.find(item => item.id === evaluation.milestoneId);
          if (!milestone) throw new StoryConflict('UNKNOWN_MILESTONE');
          const evidence = await resolveEvidence(evaluation.evidence);
          if (milestone.status !== 'achieved') { milestone.status = 'achieved'; milestone.evidenceFactIds = evidence; changed = true; }
        }
        stage.progress = stageProgress(stage);
        if(changed){const experience=await this.experience.state(storyId,client);const obstacle=experience.resources?.challenges.find(c=>c.id==='local_obstacle');if(obstacle){obstacle.revision++;obstacle.state='open';obstacle.title=stage.milestones.find(m=>m.status==='pending')?.criterion??stage.objective;await this.experience.save(client,storyId,experience,'行动条件随里程碑更新',turnId);}}
        if (review.failure) {
          if (!stage.failureConditions[review.failure.conditionIndex]) throw new StoryConflict('UNKNOWN_FAILURE_CONDITION');
          const evidence = await resolveEvidence(review.failure.evidence);
          stage.failureReason = review.failure.reason; stage.failureEvidenceFactIds = evidence;
          factIds.push(await this.addEvent(client, storyId, turnId, endTime, 'stage', review.failure.reason, ['stage_failure'], { type: 'stage_failure_evidence', stageId: stage.id, conditionIndex: review.failure.conditionIndex, evidenceFactIds: evidence }));
          await this.settleStage(client, storyId, stage, 'failure'); stageTransition = true; changed = true;
        } else if (stage.milestones.length && stage.progress === 100) {
          await this.settleStage(client, storyId, stage, 'success'); stageTransition = true; changed = true;
        } else if (stage.deadlineMinutes !== null && endTime >= stage.deadlineMinutes) {
          stage.awaitingDeadline = true; changed = true;
          await client.query("UPDATE autoplay_sessions SET data=jsonb_set(jsonb_set(data,'{status}','\"paused\"'::jsonb),'{pauseReason}',to_jsonb('阶段截止，请延长期限或结束阶段'::text)),updated_at=$2 WHERE story_id=$1 AND data->>'status'='running'", [storyId, Date.now()]);
        }
        if (changed) { stage.revision += 1; factIds.push(await this.saveStage(client, storyId, stage, turnId, endTime, stage.awaitingDeadline ? 'deadline_reached' : stageTransition ? 'settled' : 'milestones_updated')); }
      }
      const count = await client.query('SELECT count(*)::int AS count FROM scenes WHERE story_id=$1', [storyId]);
      const scene = sceneSchema.parse({ id: randomUUID(), turnId, seq: count.rows[0].count + 1, stageId: stage?.id ?? null, startTime, endTime, location: plan.location, title: plan.title, prose: '正文正在生成', summary: '正文正在生成', participants: plan.participants, factIds, choices: [], published: false });
      if (plan.requiresPlayerChoice && !stageTransition) {
        scene.decisionId = randomUUID();
        const decision = decisionSchema.parse({ id: scene.decisionId, storyId, sceneId: scene.id, turnId, stageId: stage?.id ?? null, prompt: plan.choicePrompt ?? '请选择下一步行动', options: sceneOptions(scene.id, plan.choices), status: 'pending', choice: null, continuationTurnId: null, actionIntent: plan.resourceIntent });
        await client.query('INSERT INTO story_decisions(id,story_id,scene_id,turn_id,data) VALUES($1,$2,$3,$4,$5)', [decision.id, storyId, scene.id, turnId, decision]);
        scene.factIds.push(await this.addEvent(client, storyId, turnId, endTime, 'action', '可选行动已提出，等待确认。', ['decision_point'], { type: 'decision_created', decision }));
      }
      await client.query('INSERT INTO scenes(id,story_id,turn_id,seq,start_time,end_time,data,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)', [scene.id, storyId, turnId, scene.seq, startTime, endTime, scene, Date.now()]);
      const reason = stage?.awaitingDeadline ? '阶段截止，请延长期限或结束阶段。' : stageTransition ? '阶段已结算，请确认下一阶段或查看结局。' : scene.decisionId ? plan.choicePrompt ?? '请选择下一步行动。' : null;
      await client.query('UPDATE stories SET clock=$2,revision=revision+1,updated_at=$3 WHERE id=$1', [storyId, endTime, Date.now()]);
      await client.query("UPDATE story_turns SET status='narrating',current_step='narrating',waiting_reason=$2,updated_at=$3 WHERE id=$1", [turnId, reason, Date.now()]);
      await this.experience.checkpoint(client,storyId,'行动已提交，正文尚待生成');await client.query('COMMIT'); return { scene, waiting: !!reason, reason, stageTransition };
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }

  async sceneFacts(turnId: string) {
    const scene = await this.database.pool.query('SELECT data FROM scenes WHERE turn_id=$1', [turnId]);
    if (!scene.rows[0]) throw new Error('SCENE_NOT_FOUND');
    const parsed = sceneSchema.parse(scene.rows[0].data);
    const facts = (await this.database.pool.query("SELECT * FROM facts WHERE story_id=(SELECT story_id FROM story_turns WHERE id=$1) AND id=ANY($2::uuid[]) ORDER BY seq", [turnId, parsed.factIds])).rows.map(parseFact);
    return { scene: parsed, facts };
  }

  async saveNarrationState(turnId: string, state: Record<string, unknown>) {
    await this.database.pool.query('UPDATE story_turns SET narration_state=$2,updated_at=$3 WHERE id=$1', [turnId, state, Date.now()]);
    await this.database.pool.query('INSERT INTO narration_attempts(id,turn_id,data,created_at) VALUES($1,$2,$3,$4)', [randomUUID(), turnId, state, Date.now()]);
  }

  async finalizeNarration(turnId: string, narrationInput: Narration, validation?: NarrationValidation) {
    const narration = narrationSchema.parse(narrationInput); const client = await this.database.pool.connect();
    try {
      await client.query('BEGIN'); const lookup = await client.query('SELECT story_id FROM story_turns WHERE id=$1', [turnId]); if (!lookup.rows[0]) throw new Error('TURN_NOT_FOUND');
      await this.lockStory(client, lookup.rows[0].story_id);
      const turn = (await client.query('SELECT * FROM story_turns WHERE id=$1 FOR UPDATE', [turnId])).rows[0];
      if (turn.status !== 'narrating') throw new StoryConflict('TURN_NOT_READY_FOR_NARRATION');
      const result = await client.query('SELECT id,data FROM scenes WHERE turn_id=$1', [turnId]); if (!result.rows[0]) throw new Error('SCENE_NOT_FOUND');
      const old = sceneSchema.parse(result.rows[0].data);
      const decisionRow = old.decisionId ? (await client.query('SELECT data FROM story_decisions WHERE id=$1', [old.decisionId])).rows[0] : null;
      const decision = decisionRow ? decisionSchema.parse(decisionRow.data) : null;
      const choices = turn.narration_retry ? old.choices : decision?.options.length ? decision.options.map(option => option.text) : narration.choices;
      const options = turn.narration_retry ? old.options : sceneOptions(old.id, choices);
      const scene = sceneSchema.parse({ ...old, ...narration, choices, options, published: true, validation: validation ?? old.validation });
      if (decision && !turn.narration_retry) {
        decision.options = options;
        await client.query('UPDATE story_decisions SET data=$2 WHERE id=$1', [decision.id, decision]);
      }
      await client.query('UPDATE scenes SET data=$2 WHERE id=$1', [scene.id, scene]);
      await client.query("UPDATE story_turns SET status='summarizing',current_step='summarizing',error=NULL,updated_at=$2 WHERE id=$1", [turnId, Date.now()]);
      await client.query('UPDATE stories SET revision=revision+1,updated_at=$2 WHERE id=$1', [turn.story_id, Date.now()]);
      await client.query('COMMIT'); return { scene, waiting: !!turn.waiting_reason, reason: turn.waiting_reason as string | null };
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }

  async completeTurn(turnId: string) {
    const client = await this.database.pool.connect();
    try {
      await client.query('BEGIN'); const lookup = await client.query('SELECT story_id FROM story_turns WHERE id=$1', [turnId]); if (!lookup.rows[0]) throw new Error('TURN_NOT_FOUND');
      const story = await this.lockStory(client, lookup.rows[0].story_id);
      const turn = (await client.query('SELECT * FROM story_turns WHERE id=$1 FOR UPDATE', [turnId])).rows[0];
      if (turn.status !== 'summarizing') throw new StoryConflict('TURN_NOT_READY_TO_COMPLETE');
      const status = turn.narration_retry ? turn.resume_status ?? 'completed' : story.status === 'finished' ? 'completed' : turn.waiting_reason ? 'waiting_player' : 'completed';
      await client.query('UPDATE story_turns SET status=$2,current_step=$2,narration_retry=false,resume_status=NULL,updated_at=$3 WHERE id=$1', [turnId, status, Date.now()]);
      await client.query('UPDATE stories SET running_turn_id=NULL,revision=revision+1,updated_at=$2 WHERE id=$1', [story.id, Date.now()]);
      await this.experience.checkpoint(client, story.id, status === 'waiting_player' ? '等待选择或阶段处理' : '回合完成');
      await client.query('COMMIT'); return { waiting: status === 'waiting_player', reason: turn.waiting_reason as string | null };
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }

  async retryTurn(storyId: string, turnId: string, key: string, narrationOnly = false) {
    const client = await this.database.pool.connect();
    try {
      await client.query('BEGIN'); const story = await this.lockStory(client, storyId);
      const prior = await client.query('SELECT response FROM story_requests WHERE story_id=$1 AND key=$2', [storyId, key]);
      if (prior.rows[0]) { if (prior.rows[0].response.turnId !== turnId || prior.rows[0].response.narrationOnly !== narrationOnly) throw new StoryConflict('IDEMPOTENCY_CONFLICT'); await client.query('COMMIT'); return prior.rows[0].response; }
      const row = (await client.query('SELECT * FROM story_turns WHERE id=$1 AND story_id=$2', [turnId, storyId])).rows[0]; if (!row) throw new Error('TURN_NOT_FOUND');
      if (story.running_turn_id || (await client.query('SELECT id FROM story_turns WHERE story_id=$1 AND id<>$2 AND status=ANY($3::text[])', [storyId, turnId, ['queued', ...processing]])).rows.length) throw new StoryConflict('STORY_BUSY');
      const committed = (await client.query('SELECT id FROM scenes WHERE turn_id=$1', [turnId])).rows.length > 0;
      if (narrationOnly && !committed) throw new StoryConflict('SCENE_NOT_COMMITTED');
      if (narrationOnly && !['completed', 'waiting_player'].includes(row.status)) throw new StoryConflict('USE_TURN_RETRY');
      if (!narrationOnly && committed && !['narrating', 'summarizing'].includes(row.status)) throw new StoryConflict('USE_NARRATION_RETRY');
      if (!committed && row.status !== 'failed') throw new StoryConflict('TURN_NOT_FAILED');
      if (!committed) await this.assertAdvance(client, story);
      await client.query('UPDATE story_turns SET status=$2,current_step=$2,import_suspended=false,error=NULL,narration_state=$3,narration_retry=$4,resume_status=$5,updated_at=$6 WHERE id=$1', [turnId, committed ? 'narrating' : 'queued', narrationOnly ? null : row.narration_state, narrationOnly || row.narration_retry, narrationOnly ? (row.narration_retry ? row.resume_status : row.status) : row.resume_status, Date.now()]);
      await client.query('UPDATE story_outbox SET dispatched=false WHERE turn_id=$1', [turnId]);
      const response = { turnId, narrationOnly };
      await client.query('INSERT INTO story_requests(story_id,key,response) VALUES($1,$2,$3)', [storyId, key, response]);
      await client.query('COMMIT'); return response;
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }

  async createAutoplay(storyId: string, request: AutoplayRequest) {
    const client = await this.database.pool.connect();
    try {
      await client.query('BEGIN'); const story = await this.lockStory(client, storyId); await this.assertAdvance(client, story);
      if ((await client.query("SELECT id FROM story_decisions WHERE story_id=$1 AND data->>'status'='pending'", [storyId])).rows.length) throw new StoryConflict('PLAYER_CHOICE_REQUIRED');
      if (story.running_turn_id || (await client.query("SELECT id FROM story_turns WHERE story_id=$1 AND status='queued'", [storyId])).rows.length) throw new StoryConflict('STORY_BUSY');
      if ((await client.query("SELECT id FROM autoplay_sessions WHERE story_id=$1 AND data->>'status'='running'", [storyId])).rows.length) throw new StoryConflict('AUTOPLAY_ALREADY_RUNNING');
      const session = autoplaySessionSchema.parse({ id: randomUUID(), storyId, ...request, startTime: Number(story.clock), targetTime: Number(story.clock) + request.durationMinutes, scenes: 0, status: 'running', pauseReason: null });
      await client.query('INSERT INTO autoplay_sessions(id,story_id,data,created_at,updated_at) VALUES($1,$2,$3,$4,$4)', [session.id, storyId, session, Date.now()]);
      const turnId = await this.insertTurn(client, storyId, '沿当前目标推进普通可撤回行动。', 'autoplay', `autoplay:${session.id}:1`);
      await this.addEvent(client, storyId, turnId, Number(story.clock), 'action', `托管授权至故事时间 ${session.targetTime} 分钟；新的重大选择仍须暂停。`, ['autoplay', 'autoplay_authorized'], { type: 'autoplay_authorized', sessionId: session.id, targetTime: session.targetTime, maxScenes: session.maxScenes });
      await client.query('UPDATE stories SET revision=revision+1 WHERE id=$1', [storyId]);
      await client.query('COMMIT'); return session;
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }

  async advanceAutoplay(turnId: string, storyId: string) {
    const client = await this.database.pool.connect();
    try {
      await client.query('BEGIN'); const story = await this.lockStory(client, storyId);
      const turn = (await client.query('SELECT * FROM story_turns WHERE id=$1 AND story_id=$2', [turnId, storyId])).rows[0];
      if (!turn || turn.source !== 'autoplay' || !['completed', 'waiting_player'].includes(turn.status)) { await client.query('COMMIT'); return; }
      const key = `autoplay-account:${turnId}`;
      if ((await client.query('SELECT key FROM story_requests WHERE story_id=$1 AND key=$2', [storyId, key])).rows.length) { await client.query('COMMIT'); return; }
      const row = (await client.query('SELECT data FROM autoplay_sessions WHERE story_id=$1 ORDER BY created_at DESC LIMIT 1', [storyId])).rows[0];
      if (row) {
        const session = autoplaySessionSchema.parse(row.data);
        if (turn.idempotency_key.startsWith(`autoplay:${session.id}:`)) {
          session.scenes += 1;
          if (story.status === 'finished') { session.status = 'completed'; session.pauseReason = null; }
          else if (turn.status === 'waiting_player') { session.status = 'paused'; session.pauseReason = turn.waiting_reason; }
          else if (Number(story.clock) >= session.targetTime) { session.status = 'completed'; session.pauseReason = null; }
          else if (session.scenes >= session.maxScenes) { session.status = 'paused'; session.pauseReason = turn.waiting_reason ?? '已达到场景上限'; }
          if (session.status === 'running') {
            await this.assertAdvance(client, story);
            await this.insertTurn(client, storyId, '沿当前目标继续推进可撤回行动。', 'autoplay', `autoplay:${session.id}:${session.scenes + 1}`);
          }
          await client.query('UPDATE autoplay_sessions SET data=$2,updated_at=$3 WHERE id=$1', [session.id, session, Date.now()]);
        }
      }
      await client.query('INSERT INTO story_requests(story_id,key,response) VALUES($1,$2,$3)', [storyId, key, { accounted: true }]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }

  async resumeAutoplay(storyId: string) {
    const client = await this.database.pool.connect();
    try {
      await client.query('BEGIN'); const story = await this.lockStory(client, storyId);
      const row = (await client.query('SELECT data FROM autoplay_sessions WHERE story_id=$1 ORDER BY created_at DESC LIMIT 1', [storyId])).rows[0];
      if (!row) throw new StoryConflict('AUTOPLAY_NOT_PAUSED'); const session = autoplaySessionSchema.parse(row.data);
      if (session.status === 'running') { await client.query('COMMIT'); return session; }
      if (session.status !== 'paused') throw new StoryConflict('AUTOPLAY_NOT_PAUSED');
      await this.assertAdvance(client, story);
      if ((await client.query("SELECT id FROM story_decisions WHERE story_id=$1 AND data->>'status'='pending'", [storyId])).rows.length) throw new StoryConflict('PLAYER_CHOICE_REQUIRED');
      if (story.running_turn_id || (await client.query("SELECT id FROM story_turns WHERE story_id=$1 AND status='queued'", [storyId])).rows.length) throw new StoryConflict('STORY_BUSY');
      if (Number(story.clock) >= session.targetTime) session.status = 'completed';
      else {
        if (session.scenes >= session.maxScenes) throw new StoryConflict('AUTOPLAY_SCENE_LIMIT');
        session.status = 'running';
        await this.insertTurn(client, storyId, '继续托管中的普通可撤回行动。', 'autoplay', `autoplay:${session.id}:${session.scenes + 1}:${randomUUID()}`);
      }
      session.pauseReason = null;
      await client.query('UPDATE autoplay_sessions SET data=$2,updated_at=$3 WHERE id=$1', [session.id, session, Date.now()]);
      await client.query('COMMIT'); return session;
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }

  async recordAutoplayAuthorization(storyId: string, sourceTurnId: string, session: AutoplaySession) {
    const client = await this.database.pool.connect(); try { await client.query('BEGIN'); const story = await client.query('SELECT clock FROM stories WHERE id=$1 FOR UPDATE', [storyId]); if (!story.rows.length) throw new Error('STORY_NOT_FOUND'); const seq = await this.nextFact(client, storyId), id = randomUUID();
      await client.query('INSERT INTO facts(id,story_id,seq,time,kind,text,tags,visibility,source_turn_id,payload,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)', [id, storyId, seq, Number(story.rows[0].clock), 'action', `玩家开启托管至故事时间 ${session.targetTime} 分钟，并授权系统选择可撤回、非重大调查方向；重大或不可逆决定仍须暂停。`, ['autoplay', 'autoplay_authorized'], 'player', sourceTurnId, { type: 'autoplay_authorized', sessionId: session.id, targetTime: session.targetTime, maxScenes: session.maxScenes }, Date.now()]);
      await client.query('UPDATE stories SET revision=revision+1,updated_at=$2 WHERE id=$1', [storyId, Date.now()]); await client.query('COMMIT'); return id;
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }

  async autoplay(storyId: string) { const { rows } = await this.database.pool.query('SELECT id,data FROM autoplay_sessions WHERE story_id=$1 ORDER BY created_at DESC LIMIT 1', [storyId]); return rows[0] ? autoplaySessionSchema.parse(rows[0].data) : null; }
  async updateAutoplay(session: AutoplaySession) { const parsed = autoplaySessionSchema.parse(session); await this.database.pool.query('UPDATE autoplay_sessions SET data=$2,updated_at=$3 WHERE id=$1', [parsed.id, parsed, Date.now()]); }
  async stopAutoplay(storyId: string, reason = '玩家停止托管') { const session = await this.autoplay(storyId); if (!session || session.status !== 'running') return session; session.status = 'stopped'; session.pauseReason = reason; await this.updateAutoplay(session); return session; }

  async pendingProposals(storyId: string) { const { rows } = await this.database.pool.query("SELECT p.id,p.stage_id,p.reason,p.route_id,p.graph_revision,s.data FROM stage_proposals p JOIN story_stages s ON s.id=p.stage_id WHERE p.story_id=$1 AND p.status='pending' ORDER BY p.created_at,p.id", [storyId]); return rows.map(row=>({id:row.id,stageId:row.stage_id,reason:row.reason,routeId:row.route_id,graphRevision:row.graph_revision,stage:storyStageSchema.parse(row.data)})); }
  async pendingProposal(storyId: string) { const rows=await this.pendingProposals(storyId);return rows.length===1?rows[0]:null; }

  async editGraph(storyId:string, revision:number, input:OutlineDraft) {
    const outline=outlineDraftSchema.parse(input);validateGraph(outline);if(!outline.graph)throw new StoryConflict('GRAPH_REQUIRED');
    const client=await this.database.pool.connect();
    try{
      await client.query('BEGIN');const story=await this.lockStory(client,storyId);if(story.running_turn_id)throw new StoryConflict('STORY_BUSY');
      const old=outlineDraftSchema.parse(story.outline);if((old.graph?.revision??1)!==revision)throw new StoryConflict('STALE_GRAPH');
      const rows=(await client.query('SELECT data FROM story_stages WHERE story_id=$1 ORDER BY position',[storyId])).rows.map(r=>storyStageSchema.parse(r.data));
      for(const stage of rows.filter(s=>s.status!=='planned')){
        const index=old.stages.findIndex(s=>s.nodeId? s.nodeId===stage.nodeId : old.stages.indexOf(s)===stage.position);
        const next=outline.stages.find(s=>s.nodeId===stage.nodeId);
        if(!next||outline.stages.indexOf(next)!==stage.position||digest(next)!==digest(old.stages[index]))throw new StoryConflict('EXECUTED_STAGE_IMMUTABLE');
      }
      if(digest(old.characters)!==digest(outline.characters)||old.arcObjective!==outline.arcObjective||old.stakes!==outline.stakes)throw new StoryConflict('GRAPH_EDIT_ONLY');
      const accepted=(await client.query("SELECT route_id FROM stage_proposals WHERE story_id=$1 AND status='accepted'",[storyId])).rows;
      for(const {route_id} of accepted)if(route_id&&digest(old.graph?.routes.find(r=>r.id===route_id))!==digest(outline.graph.routes.find(r=>r.id===route_id)))throw new StoryConflict('EXECUTED_ROUTE_IMMUTABLE');
      outline.graph.revision=revision+1;
      const nextStages=outline.stages.map((draft,position)=>{
        const prior=rows.find(s=>s.nodeId===draft.nodeId);
        return prior?.status!=='planned'&&prior?prior:initializeMilestones(storyStageSchema.parse({...draft,id:prior?.id??randomUUID(),position,status:'planned',progress:0,revision:(prior?.revision??0)+1,milestones:prior?.milestones??[]}));
      });
      await client.query('DELETE FROM story_stages WHERE story_id=$1',[storyId]);
      for(const stage of nextStages)await client.query('INSERT INTO story_stages(id,story_id,position,data) VALUES($1,$2,$3,$4)',[stage.id,storyId,stage.position,stage]);
      await client.query('UPDATE stories SET outline=$2,revision=revision+1 WHERE id=$1',[storyId,outline]);
      await client.query("UPDATE stage_proposals SET status='superseded' WHERE story_id=$1 AND status='pending'",[storyId]);
      const active=nextStages.find(s=>s.id===story.active_stage_id);if(active?.outcome)await this.settleStage(client,storyId,active,active.outcome);
      await this.experience.event(client,storyId,{type:'stage_graph_edited',outline,stages:nextStages},'后续路线已更新');
      await this.experience.checkpoint(client,storyId,'后续路线更新');await client.query('COMMIT');return outline;
    }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
  }
  async closeStageAtBoundary(storyId: string, boundaryTime: number, sourceTurnId: string) {
    const client = await this.database.pool.connect();
    try {
      await client.query('BEGIN'); const story = await this.lockStory(client, storyId);
      const row = (await client.query('SELECT data FROM story_stages WHERE id=$1', [story.active_stage_id])).rows[0];
      if (!row) { await client.query('COMMIT'); return null; }
      const stage = storyStageSchema.parse(row.data);
      if (stage.status !== 'active' || stage.deadlineMinutes !== boundaryTime || Number(story.clock) < boundaryTime) { await client.query('COMMIT'); return null; }
      if (!stage.awaitingDeadline) {
        stage.awaitingDeadline = true; stage.revision += 1;
        await this.saveStage(client, storyId, stage, sourceTurnId, Number(story.clock), 'deadline_reached');
        await client.query('UPDATE stories SET revision=revision+1,updated_at=$2 WHERE id=$1', [storyId, Date.now()]);
        await client.query("UPDATE autoplay_sessions SET data=jsonb_set(jsonb_set(data,'{status}','\"paused\"'::jsonb),'{pauseReason}',to_jsonb('阶段截止，请处理期限'::text)) WHERE story_id=$1 AND data->>'status'='running'", [storyId]);
      }
      await client.query('COMMIT'); return stage;
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }

  async resolveDeadline(storyId: string, stageId: string, input: DeadlineRequest) {
    const request = deadlineRequestSchema.parse(input); const client = await this.database.pool.connect();
    try {
      await client.query('BEGIN'); const story = await this.lockStory(client, storyId);
      const previous = await client.query('SELECT response FROM story_requests WHERE story_id=$1 AND key=$2', [storyId, request.idempotencyKey]);
      if (previous.rows[0]) {
        const original = previous.rows[0].response.request;
        if (previous.rows[0].response.stageId !== stageId || original?.action !== request.action || original?.revision !== request.revision || original?.deadlineMinutes !== request.deadlineMinutes) throw new StoryConflict('IDEMPOTENCY_CONFLICT');
        await client.query('COMMIT'); return previous.rows[0].response;
      }
      if (story.running_turn_id) throw new StoryConflict('STORY_BUSY');
      if (story.active_stage_id !== stageId) throw new StoryConflict('STALE_STAGE');
      const stage = storyStageSchema.parse((await client.query('SELECT data FROM story_stages WHERE id=$1', [stageId])).rows[0]?.data);
      if (stage.revision !== request.revision) throw new StoryConflict('STALE_STAGE');
      if (!stage.awaitingDeadline) throw new StoryConflict('STAGE_NOT_OVERDUE');
      if (request.action === 'extend') {
        if (!request.deadlineMinutes || request.deadlineMinutes <= Number(story.clock)) throw new StoryConflict('DEADLINE_MUST_BE_FUTURE');
        stage.deadlineMinutes = request.deadlineMinutes; stage.awaitingDeadline = false;
      } else await this.settleStage(client, storyId, stage, stage.progress > 0 ? 'partial' : 'abandoned');
      stage.revision += 1;
      const eventId = await this.saveStage(client, storyId, stage, randomUUID(), Number(story.clock), request.action === 'extend' ? 'deadline_extended' : 'closed_by_player');
      await client.query("UPDATE story_turns SET status='completed',current_step='completed',waiting_reason=NULL,updated_at=$2 WHERE story_id=$1 AND status='waiting_player' AND id NOT IN (SELECT turn_id FROM story_decisions WHERE story_id=$1 AND data->>'status'='pending')", [storyId, Date.now()]);
      await client.query('UPDATE stories SET revision=revision+1,updated_at=$2 WHERE id=$1', [storyId, Date.now()]);
      await client.query("UPDATE story_outbox SET dispatched=false WHERE turn_id IN (SELECT id FROM story_turns WHERE story_id=$1 AND status='queued')", [storyId]);
      const response = { stageId, stage, eventId, request };
      await this.experience.checkpoint(client, storyId, '阶段期限处理');
      await client.query('INSERT INTO story_requests(story_id,key,response) VALUES($1,$2,$3)', [storyId, request.idempotencyKey, response]);
      await client.query('COMMIT'); return response;
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }

  async reviewProposal(storyId: string, proposalId: string, decision: 'accept' | 'reject') {
    const client = await this.database.pool.connect();
    try {
      await client.query('BEGIN'); const story = await this.lockStory(client, storyId);
      if (story.running_turn_id) throw new StoryConflict('STORY_BUSY');
      const row = (await client.query('SELECT * FROM stage_proposals WHERE id=$1 AND story_id=$2 FOR UPDATE', [proposalId, storyId])).rows[0];
      if (!row) throw new Error('PROPOSAL_NOT_FOUND');
      if (row.status === 'accepted') { if (decision !== 'accept') throw new StoryConflict('PROPOSAL_ALREADY_ACCEPTED'); await this.experience.checkpoint(client,storyId,'进入下一阶段');await client.query('COMMIT'); return { accepted: true }; }
      // Deferring a proposal leaves it available; it must not strand a closed stage.
      if (decision === 'reject') { await client.query('COMMIT'); return { accepted: false }; }
      const stage = storyStageSchema.parse((await client.query('SELECT data FROM story_stages WHERE id=$1', [row.stage_id])).rows[0].data);
      const previous = storyStageSchema.parse((await client.query('SELECT data FROM story_stages WHERE id=$1', [story.active_stage_id])).rows[0].data);
      const outline = outlineDraftSchema.parse(story.outline);
      const eligible = outline.graph ? row.graph_revision === outline.graph.revision && eligibleRoutes(outline.graph,previous,await this.experience.state(storyId,client)).some(route=>route.id===row.route_id&&route.to===stage.nodeId) : stage.position === previous.position+1;
      if (!['completed', 'failed', 'closed'].includes(previous.status) || !eligible || stage.status !== 'planned') throw new StoryConflict('STALE_STAGE_PROPOSAL');
      stage.status = 'active'; stage.revision += 1;
      if (stage.deadlineMinutes === null && stage.entryBudgetMinutes !== null) stage.deadlineMinutes = Number(story.clock) + stage.entryBudgetMinutes;
      stage.awaitingDeadline = stage.deadlineMinutes !== null && stage.deadlineMinutes <= Number(story.clock);
      await client.query("UPDATE stage_proposals SET status='accepted',reviewed_at=$2 WHERE id=$1", [proposalId, Date.now()]);
      await client.query("UPDATE stage_proposals SET status='superseded',reviewed_at=$3 WHERE story_id=$1 AND id<>$2 AND status='pending'",[storyId,proposalId,Date.now()]);
      await client.query('UPDATE stories SET active_stage_id=$2,revision=revision+1,updated_at=$3 WHERE id=$1', [storyId, stage.id, Date.now()]);
      await this.saveStage(client, storyId, stage, proposalId, Number(story.clock), 'stage_accepted');
      await client.query("UPDATE story_turns SET status='completed',current_step='completed',waiting_reason=NULL,updated_at=$2 WHERE story_id=$1 AND status='waiting_player'", [storyId, Date.now()]);
      await client.query("UPDATE story_outbox SET dispatched=false WHERE turn_id IN (SELECT id FROM story_turns WHERE story_id=$1 AND status='queued')", [storyId]);
      await client.query('COMMIT'); return { accepted: true };
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }

  async editStage(storyId: string, stageInput: StoryStage) {
    const requested = storyStageSchema.parse(stageInput); const client = await this.database.pool.connect();
    try {
      await client.query('BEGIN'); const story = await this.lockStory(client, storyId);
      const found = await client.query('SELECT data FROM story_stages WHERE id=$1 AND story_id=$2', [requested.id, storyId]); if (!found.rows[0]) throw new Error('STAGE_NOT_FOUND');
      const old = storyStageSchema.parse(found.rows[0].data);
      if (requested.revision !== old.revision) throw new StoryConflict('STALE_STAGE');
      if (!['active', 'planned'].includes(old.status)) throw new StoryConflict('STAGE_ALREADY_SETTLED');
      if (old.awaitingDeadline) throw new StoryConflict('USE_DEADLINE_RESOLUTION');
      const stage = initializeMilestones({ ...requested, status: old.status, outcome: old.outcome, failureReason: old.failureReason, failureEvidenceFactIds: old.failureEvidenceFactIds, revision: old.revision + 1, legacyProgress: old.legacyProgress });
      stage.milestones = stage.milestones.map(item => old.milestones.find(prior => prior.id === item.id) ?? item);
      stage.progress = stageProgress(stage);
      stage.awaitingDeadline = stage.status === 'active' && stage.deadlineMinutes !== null && stage.deadlineMinutes <= Number(story.clock);
      await this.saveStage(client, storyId, stage, randomUUID(), Number(story.clock), 'stage_edited');
      await client.query('UPDATE stories SET revision=revision+1,updated_at=$2 WHERE id=$1', [storyId, Date.now()]);
      await client.query('COMMIT'); return stage;
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }

  async ensureNoProcessing(storyId: string) { const { rows } = await this.database.pool.query('SELECT id FROM story_turns WHERE story_id=$1 AND status=ANY($2::text[]) LIMIT 1', [storyId, processing]); return !rows.length; }

  async stateHashes(storyId: string, query: Pick<PoolClient, 'query'> = this.database.pool, atSeq?:number) {
    const [storyResult, stageResult, characterResult, relationshipResult, factResult, sceneResult, decisionResult] = await (async()=>{const values=[];for(const read of [
      ()=>query.query('SELECT outline,config,prompt_version,clock,active_stage_id,status FROM stories WHERE id=$1', [storyId]),
      ()=>query.query('SELECT data FROM story_stages WHERE story_id=$1 ORDER BY position', [storyId]),
      ()=>query.query("SELECT data FROM characters WHERE story_id=$1 ORDER BY id", [storyId]),
      ()=>query.query('SELECT data FROM relationships WHERE story_id=$1 ORDER BY from_id,to_id', [storyId]),
      ()=>query.query('SELECT id,seq,source_turn_id,payload FROM facts WHERE story_id=$1 AND seq<=coalesce($2,2147483647) ORDER BY seq', [storyId,atSeq??null]),
      ()=>query.query('SELECT data FROM scenes WHERE story_id=$1 ORDER BY seq', [storyId]),
      ()=>query.query('SELECT data FROM story_decisions WHERE story_id=$1', [storyId]),
    ])values.push(await read());return values;})();
    if (!storyResult.rows.length) throw new Error('STORY_NOT_FOUND'); const story = storyResult.rows[0]; const outline = outlineDraftSchema.parse(story.outline);
    const stages = stageResult.rows.map(row => storyStageSchema.parse(row.data)); const characters = characterResult.rows.map(row => characterSchema.parse(row.data)); const relationships = relationshipResult.rows.map(row => relationshipSchema.parse(row.data)); const scenes = sceneResult.rows.map(row => sceneSchema.parse(row.data)).filter(scene=>atSeq===undefined||scene.factIds.every(id=>factResult.rows.some(f=>f.id===id)));
    const mutableCharacter = (character: Character) => character;
    const mutableRelation = (relation: Relationship) => ({ from: relation.from, to: relation.to, trust: relation.trust, affinity: relation.affinity, tension: relation.tension, summary: relation.summary, evidenceFactIds: relation.evidenceFactIds, version: relation.version });
    const decisions = decisionResult.rows.map(row => decisionSchema.parse(row.data));
    const featureRow=(await query.query('SELECT data FROM story_experience WHERE story_id=$1',[storyId])).rows[0];
    const features=experienceStateSchema.parse(featureRow?.data??{});
    const initialConfig=(await query.query('SELECT config,version FROM prompt_revisions WHERE story_id=$1 ORDER BY version LIMIT 1',[storyId])).rows[0];
    const snapshot = (value: { clock: number; activeStageId: string | null; status: string; stages: StoryStage[]; characters: Character[]; relationships: Relationship[]; decisions: StoryDecision[];config:unknown;outline:unknown;features:unknown;promptVersion:number }) => ({
      config:value.config,outline:value.outline,features:value.features,promptVersion:value.promptVersion,
      clock: value.clock, activeStageId: value.activeStageId, status: value.status,
      stages: [...value.stages].sort((a,b)=>a.position-b.position),
      characters: value.characters.map(mutableCharacter).sort((a, b) => a.id.localeCompare(b.id)), relationships: value.relationships.map(mutableRelation).sort((a, b) => `${a.from}:${a.to}`.localeCompare(`${b.from}:${b.to}`)),
      decisions: [...value.decisions].sort((a, b) => a.id.localeCompare(b.id)),
      facts: factResult.rows.map(row => ({ id: row.id, seq: Number(row.seq), sourceTurnId: row.source_turn_id })), scenes: scenes.map(scene => ({ id: scene.id, turnId: scene.turnId, seq: scene.seq, endTime: scene.endTime, factIds: scene.factIds })),
    });
    const actual = snapshot({ clock: Number(story.clock), activeStageId: story.active_stage_id, status: story.status, stages, characters, relationships, decisions,config:storyWorldConfigSchema.parse(story.config),outline,features,promptVersion:Number(story.prompt_version) });
    const replayStages = stages.map((stage, position) => storyStageSchema.parse({ ...stage, status: position === 0 ? 'active' : 'planned', progress: 0, revision: 1 }));
    const replayCharacters = outline.characters.map(character => characterSchema.parse({ ...character, mood: '平静', condition: '状态稳定', currentGoal: character.drives[0] ?? '', recentBeat: '故事尚未开始', unresolvedHooks: [], lastSceneSeq: 0, spotlight: character.importance === 'protagonist' ? 100 : character.importance === 'core' ? 80 : 40, version: 1 }));
    const protagonist = replayCharacters.find(character => character.importance === 'protagonist')!;
    const replayRelationships = replayCharacters.filter(character => character.id !== protagonist.id).map(character => relationshipSchema.parse({ id: randomUUID(), from: protagonist.id, to: character.id, trust: 0, affinity: 0, tension: 0, summary: '关系将在故事中形成', evidenceFactIds: [], version: 1 }));
    let activeStageId: string | null = replayStages[0]?.id ?? null;
    let storyStatus = 'active';
    let replayFeatures=experienceStateSchema.parse({}),replayOutline=outline,replayConfig=storyWorldConfigSchema.parse(initialConfig?.config??story.config),replayVersion=Number(initialConfig?.version??story.prompt_version);
    let replayDecisions: StoryDecision[] = [];
    for (const fact of factResult.rows) {
      const payload = fact.payload as any; if (!payload?.type) continue;
      if(payload.type==='config_changed'){replayConfig=storyWorldConfigSchema.parse(payload.config);replayVersion=payload.version;continue;}
      if(payload.type==='experience_initialized'||payload.type==='experience_migrated'){replayFeatures=experienceStateSchema.parse(payload.state);if(payload.outline)replayOutline=outlineDraftSchema.parse(payload.outline);if(payload.config)replayConfig=storyWorldConfigSchema.parse(payload.config);if(payload.promptVersion)replayVersion=payload.promptVersion;if(payload.characters)replayCharacters.splice(0,replayCharacters.length,...payload.characters.map((c:unknown)=>characterSchema.parse(c)));if(payload.relationships)replayRelationships.splice(0,replayRelationships.length,...payload.relationships.map((r:unknown)=>relationshipSchema.parse(r)));if(payload.stages){replayStages.splice(0,replayStages.length,...payload.stages.map((s:unknown)=>storyStageSchema.parse(s)));activeStageId=payload.activeStageId;storyStatus=payload.storyStatus;}continue;}
      if(payload.type==='experience_delta'){const removed=new Set(payload.removedKnowledge??[]),updates=new Set((payload.knowledgeUpdates??[]).map((k:any)=>k.id));replayFeatures=experienceStateSchema.parse({...payload.state,knowledge:[...replayFeatures.knowledge.filter(k=>!removed.has(k.id)).map(k=>(payload.knowledgeUpdates??[]).find((u:any)=>u.id===k.id)??k),...(payload.knowledgeUpdates??[]).filter((k:any)=>!replayFeatures.knowledge.some(p=>p.id===k.id))]});continue;}
      if(payload.type==='experience_snapshot'){replayFeatures=experienceStateSchema.parse(payload.state);continue;}
      if(payload.type==='stage_graph_edited'){replayOutline=outlineDraftSchema.parse(payload.outline);replayStages.splice(0,replayStages.length,...payload.stages.map((s:unknown)=>storyStageSchema.parse(s)));continue;}
      if (payload.type === 'story_initialized' || payload.type === 'save_migrated') {
        replayStages.splice(0, replayStages.length, ...payload.stages.map((stage: unknown) => storyStageSchema.parse(stage)));
        activeStageId = payload.activeStageId; storyStatus = payload.storyStatus;
        replayDecisions = (payload.decisions ?? []).map((value: unknown) => decisionSchema.parse(value));
      } else if (payload.type === 'stage_snapshot') {
        const index = replayStages.findIndex(stage => stage.id === payload.stage.id);
        if (index >= 0) replayStages[index] = storyStageSchema.parse(payload.stage);
        activeStageId = payload.activeStageId; storyStatus = payload.storyStatus;
        for (const value of payload.decisionStatuses ?? []) { const decision = replayDecisions.find(item => item.id === value.id); if (decision) decision.status = value.status; }
      } else if (payload.type === 'decision_created') {
        replayDecisions.push(decisionSchema.parse(payload.decision));
      } else if (payload.type === 'player_choice' && payload.decisionId) {
        const decision = replayDecisions.find(item => item.id === payload.decisionId);
        if (decision) { decision.status = 'resolved'; decision.choice = payload.choice; decision.selectedOptionId = payload.optionId ?? null; decision.continuationTurnId = payload.continuationTurnId; }
      } else if (payload.type === 'character') {
        const change = payload.change; const character = replayCharacters.find(item => item.id === change.characterId); if (!character) continue;
        if (change.field === 'hook') character.unresolvedHooks = [...new Set([...character.unresolvedHooks, change.value])].slice(-12); else (character as any)[change.field] = change.value; character.lastSceneSeq += 1; character.version += 1;
      } else if (payload.type === 'relationship') {
        const change = payload.change; let relation = replayRelationships.find(item => (item.from === change.from && item.to === change.to) || (item.from === change.to && item.to === change.from));
        if (!relation) { relation = relationshipSchema.parse({ id: randomUUID(), from: change.from, to: change.to, trust: 0, affinity: 0, tension: 0, summary: '', evidenceFactIds: [], version: 1 }); replayRelationships.push(relation); }
        relation[change.dimension as 'trust' | 'affinity' | 'tension'] = Math.max(change.dimension === 'tension' ? 0 : -100, Math.min(100, relation[change.dimension as 'trust' | 'affinity' | 'tension'] + change.delta)); relation.summary = change.reason; relation.evidenceFactIds = [...relation.evidenceFactIds, fact.id].slice(-30); relation.version += 1;
      } else if (payload.type === 'stage_progress') {
        const stage = replayStages.find(item => item.id === payload.stageId); if (stage) { stage.progress = payload.progress; stage.status = payload.status; stage.revision = payload.revision; }
      } else if (payload.type === 'stage_boundary') {
        const stage = replayStages.find(item => item.id === payload.stageId); if (stage) { stage.progress = payload.progress; stage.status = payload.status; stage.revision = payload.revision; }
      } else if (payload.type === 'stage_accepted') {
        const stage = replayStages.find(item => item.id === payload.stageId); if (stage) { stage.status = 'active'; stage.revision = payload.revision; activeStageId = stage.id; }
      }
    }
    const replay = snapshot({ clock: scenes.at(-1)?.endTime ?? 0, activeStageId, status: storyStatus, stages: replayStages, characters: replayCharacters, relationships: replayRelationships, decisions: replayDecisions,config:replayConfig,outline:replayOutline,features:replayFeatures,promptVersion:replayVersion });
    const hash = digest;
    return { stateHash: hash(actual), replayHash: hash(replay), matches: hash(actual) === hash(replay),...(atSeq===undefined?{}:{projection:{clock:scenes.at(-1)?.endTime??0,activeStageId,status:storyStatus,stages:replayStages,characters:replayCharacters,relationships:replayRelationships,decisions:replayDecisions,config:replayConfig,outline:replayOutline,features:replayFeatures,promptVersion:replayVersion}}) };
  }
}
