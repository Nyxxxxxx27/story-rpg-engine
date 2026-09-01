import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import {
  autoplaySessionSchema, characterSchema, factSchema, narrationSchema, outlineDraftSchema, relationshipSchema,
  scenePlanSchema, sceneSchema, storyStageSchema, storyTurnSchema, storyWorldConfigSchema,
  type AgentReview, type AutoplayRequest, type AutoplaySession, type CanonicalFact, type Character, type Narration,
  type OutlineDraft, type Relationship, type Scene, type ScenePlan, type StoryStage, type StoryStateView,
  type StoryTurn, type StoryWorldConfig, type TurnStatus,
} from '../contracts/index.ts';
import type { Database } from './database.ts';

export interface StoryScope { storyId: string; owner?: string }
export interface RuntimeContext { config: StoryWorldConfig; stage: StoryStage | null; characters: Character[]; facts: CanonicalFact[]; scenes: Scene[]; autoplay: AutoplaySession | null; clock: number; revision: number; outline: OutlineDraft }

const processing = ['assembling', 'directing', 'reviewing', 'repairing', 'committing', 'narrating', 'summarizing'];

export class StoryStore {
  private outboxFlushPromise: Promise<void> | null = null;
  constructor(public database: Database) {}

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
  }

  private async assertOwner(storyId: string, owner?: string) {
    const result = await this.database.pool.query('SELECT owner FROM stories WHERE id=$1', [storyId]);
    if (!result.rows.length) throw new Error('STORY_NOT_FOUND');
    if (owner && result.rows[0].owner !== owner) throw new Error('UNAUTHORIZED');
  }

  async create(owner: string, configInput: StoryWorldConfig, seed = Math.floor(Math.random() * 2_000_000_000) + 1) {
    const config = storyWorldConfigSchema.parse(configInput); const id = randomUUID(); const now = Date.now();
    await this.database.pool.query('INSERT INTO stories(id,branch,owner,title,config,status,seed,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8)', [id, 'main', owner, config.title, config, 'draft', seed, now]);
    await this.database.pool.query('INSERT INTO prompt_revisions(id,story_id,version,config,created_at) VALUES($1,$2,1,$3,$4)', [randomUUID(), id, config, now]);
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
      await client.query('INSERT INTO prompt_revisions(id,story_id,version,config,created_at) VALUES($1,$2,$3,$4,$5)', [randomUUID(), storyId, version, config, Date.now()]); await client.query('COMMIT');
      return { version };
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }

  async saveOutline(storyId: string, owner: string | undefined, draftInput: OutlineDraft) {
    await this.assertOwner(storyId, owner); const draft = outlineDraftSchema.parse(draftInput);
    await this.database.pool.query('UPDATE stories SET outline=$2,title=$3,revision=revision+1,updated_at=$4 WHERE id=$1', [storyId, draft, draft.title, Date.now()]); return draft;
  }

  async confirmOutline(storyId: string, owner?: string, override?: OutlineDraft) {
    await this.assertOwner(storyId, owner); const client = await this.database.pool.connect();
    try {
      await client.query('BEGIN'); const row = await client.query('SELECT outline,status FROM stories WHERE id=$1 FOR UPDATE', [storyId]);
      if (row.rows[0].status !== 'draft') throw new Error('OUTLINE_ALREADY_CONFIRMED');
      const outline = outlineDraftSchema.parse(override ?? row.rows[0].outline); const stages: StoryStage[] = outline.stages.map((draft, position) => storyStageSchema.parse({ ...draft, id: randomUUID(), position, status: position === 0 ? 'active' : 'planned', progress: 0, revision: 1 }));
      for (const stage of stages) await client.query('INSERT INTO story_stages(id,story_id,position,data) VALUES($1,$2,$3,$4)', [stage.id, storyId, stage.position, stage]);
      const characters = outline.characters.map(character => characterSchema.parse({ ...character, mood: '平静', condition: '状态稳定', currentGoal: character.drives[0] ?? '', recentBeat: '故事尚未开始', unresolvedHooks: [], lastSceneSeq: 0, spotlight: character.importance === 'protagonist' ? 100 : character.importance === 'core' ? 80 : 40, version: 1 }));
      for (const character of characters) await client.query('INSERT INTO characters(story_id,id,data) VALUES($1,$2,$3)', [storyId, character.id, character]);
      const protagonist = characters.find(character => character.importance === 'protagonist')!;
      for (const character of characters.filter(character => character.id !== protagonist.id)) {
        const relation = relationshipSchema.parse({ id: randomUUID(), from: protagonist.id, to: character.id, trust: 0, affinity: 0, tension: 0, summary: '关系将在故事中形成', evidenceFactIds: [], version: 1 });
        await client.query('INSERT INTO relationships(id,story_id,from_id,to_id,data) VALUES($1,$2,$3,$4,$5)', [relation.id, storyId, relation.from, relation.to, relation]);
      }
      await client.query('UPDATE stories SET outline=$2,arc=$3,status=$4,active_stage_id=$5,revision=revision+1,updated_at=$6 WHERE id=$1', [storyId, outline, { objective: outline.arcObjective, stakes: outline.stakes }, 'active', stages[0].id, Date.now()]); await client.query('COMMIT');
      return { activeStageId: stages[0].id };
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }

  async context(storyId: string): Promise<RuntimeContext> {
    const client = await this.database.pool.connect();
    try {
      await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const story = await client.query('SELECT * FROM stories WHERE id=$1', [storyId]); if (!story.rows.length) throw new Error('STORY_NOT_FOUND'); const row = story.rows[0];
      if (row.status !== 'active' || !row.outline) throw new Error('STORY_NOT_ACTIVE');
      const stages = await client.query('SELECT data FROM story_stages WHERE story_id=$1 ORDER BY position', [storyId]);
      const characters = await client.query('SELECT data FROM characters WHERE story_id=$1 ORDER BY CASE data->>\'importance\' WHEN \'protagonist\' THEN 0 WHEN \'core\' THEN 1 ELSE 2 END,id', [storyId]);
      const facts = await client.query('SELECT id,seq,time,kind,text,tags,visibility,source_turn_id,payload FROM facts WHERE story_id=$1 ORDER BY seq DESC LIMIT 24', [storyId]);
      const scenes = await client.query('SELECT data FROM scenes WHERE story_id=$1 ORDER BY seq DESC LIMIT 8', [storyId]);
      const autoplay = await client.query('SELECT data FROM autoplay_sessions WHERE story_id=$1 ORDER BY created_at DESC LIMIT 1', [storyId]);
      await client.query('COMMIT'); const parsedStages = stages.rows.map(value => storyStageSchema.parse(value.data));
      return { config: storyWorldConfigSchema.parse(row.config), stage: parsedStages.find(stage => stage.id === row.active_stage_id) ?? null, characters: characters.rows.map(value => characterSchema.parse(value.data)), facts: facts.rows.reverse().map(value => factSchema.parse({ id: value.id, seq: value.seq, time: Number(value.time), kind: value.kind, text: value.text, tags: value.tags, visibility: value.visibility, sourceTurnId: value.source_turn_id, payload: value.payload })), scenes: scenes.rows.reverse().map(value => sceneSchema.parse(value.data)), autoplay: autoplay.rows[0] ? autoplaySessionSchema.parse(autoplay.rows[0].data) : null, clock: Number(row.clock), revision: Number(row.revision), outline: outlineDraftSchema.parse(row.outline) };
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
      const latestTurn = await client.query('SELECT * FROM story_turns WHERE story_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1', [storyId]);
      const autoplay = await client.query("SELECT data FROM autoplay_sessions WHERE story_id=$1 ORDER BY created_at DESC LIMIT 1", [storyId]);
      let parsedTurn: StoryTurn | null = null;
      if (latestTurn.rows[0]) {
        const turnRow = latestTurn.rows[0]; const steps = await client.query('SELECT * FROM turn_steps WHERE turn_id=$1 ORDER BY started_at,id', [turnRow.id]); const scene = await client.query('SELECT data FROM scenes WHERE turn_id=$1', [turnRow.id]);
        parsedTurn = this.parseTurn(turnRow, steps.rows, scene.rows[0]?.data ?? null);
      }
      await client.query('COMMIT'); const parsedStages = stages.rows.map(value => storyStageSchema.parse(value.data));
      return { id: row.id, branch: row.branch, title: row.title, status: row.status, clock: Number(row.clock), revision: Number(row.revision), config: storyWorldConfigSchema.parse(row.config), outline: row.outline ? outlineDraftSchema.parse(row.outline) : null, arc: row.arc, activeStage: parsedStages.find(stage => stage.id === row.active_stage_id) ?? null, stages: parsedStages, characters: characters.rows.map(value => characterSchema.parse(value.data)), relationships: relationships.rows.map(value => relationshipSchema.parse(value.data)), scenes: scenes.rows.reverse().map(value => sceneSchema.parse(value.data)), facts: facts.rows.reverse().map(value => factSchema.parse({ id: value.id, seq: value.seq, time: Number(value.time), kind: value.kind, text: value.text, tags: value.tags, visibility: value.visibility, sourceTurnId: value.source_turn_id, payload: value.payload })), latestTurn: parsedTurn, autoplay: autoplay.rows[0] ? autoplaySessionSchema.parse(autoplay.rows[0].data) : null };
    } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; } finally { client.release(); }
  }

  async enqueueTurn(storyId: string, input: string, source: 'web' | 'codex' | 'autoplay' | 'test', idempotencyKey: string) {
    const existing = await this.database.pool.query('SELECT id FROM story_turns WHERE story_id=$1 AND idempotency_key=$2', [storyId, idempotencyKey]); if (existing.rows[0]) return this.turn(existing.rows[0].id);
    const id = randomUUID(); const now = Date.now(); const client = await this.database.pool.connect();
    try {
      await client.query('BEGIN'); await client.query('SELECT id FROM stories WHERE id=$1 FOR UPDATE', [storyId]);
      if (source !== 'autoplay') {
        await client.query("UPDATE autoplay_sessions SET data=jsonb_set(jsonb_set(data,'{status}','\"paused\"'::jsonb),'{pauseReason}',to_jsonb('收到手动输入'::text)),updated_at=$2 WHERE story_id=$1 AND data->>'status'='running'", [storyId, now]);
        await client.query("UPDATE story_turns SET status='failed',current_step='failed',error='手动输入已取代排队中的托管回合',updated_at=$2 WHERE story_id=$1 AND source='autoplay' AND status='queued'", [storyId, now]);
      }
      await client.query('INSERT INTO story_turns(id,story_id,source,input,idempotency_key,status,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$7)', [id, storyId, source, input, idempotencyKey, 'queued', now]);
      await client.query('INSERT INTO story_outbox(id,turn_id,created_at) VALUES($1,$2,$3)', [randomUUID(), id, now]); await client.query('COMMIT');
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
      await client.query("UPDATE story_turns SET status='queued',current_step='queued',error=NULL,updated_at=$1 WHERE status=ANY($2::text[])", [Date.now(), ['assembling', 'directing', 'reviewing', 'repairing', 'committing']]);
      await client.query("UPDATE stories SET running_turn_id=NULL WHERE running_turn_id IN (SELECT id FROM story_turns WHERE status='queued')");
      await client.query("UPDATE story_outbox SET dispatched=false WHERE turn_id IN (SELECT id FROM story_turns WHERE status IN ('queued','narrating','summarizing'))");
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }

  async requeue(turnId: string) { await this.database.pool.query('UPDATE story_outbox SET dispatched=false WHERE turn_id=$1', [turnId]); }

  async runtimeData(turnId: string) {
    const { rows } = await this.database.pool.query('SELECT story_id,source,input,status,context,plan,reviews,waiting_reason FROM story_turns WHERE id=$1', [turnId]);
    if (!rows.length) throw new Error('TURN_NOT_FOUND');
    return { storyId: rows[0].story_id as string, source: rows[0].source as StoryTurn['source'], input: rows[0].input as string, status: rows[0].status as TurnStatus, context: rows[0].context, plan: rows[0].plan, reviews: rows[0].reviews, waitingReason: rows[0].waiting_reason as string | null };
  }

  async turn(turnId: string): Promise<StoryTurn> {
    const client = await this.database.pool.connect();
    try {
      const turn = await client.query('SELECT * FROM story_turns WHERE id=$1', [turnId]); if (!turn.rows.length) throw new Error('TURN_NOT_FOUND');
      const steps = await client.query('SELECT * FROM turn_steps WHERE turn_id=$1 ORDER BY started_at,id', [turnId]); const scene = await client.query('SELECT data FROM scenes WHERE turn_id=$1', [turnId]);
      return this.parseTurn(turn.rows[0], steps.rows, scene.rows[0]?.data ?? null);
    } finally { client.release(); }
  }

  private parseTurn(row: any, steps: any[], scene: unknown): StoryTurn {
    return storyTurnSchema.parse({ id: row.id, storyId: row.story_id, source: row.source, input: row.input, status: row.status, currentStep: row.current_step, createdAt: Number(row.created_at), updatedAt: Number(row.updated_at), waitingReason: row.waiting_reason, error: row.error, scene, steps: steps.filter(step => step?.id).map(step => ({ id: step.id, name: step.name, agentRole: step.agent_role, status: step.status, summary: step.summary, startedAt: Number(step.started_at), completedAt: step.completed_at === null ? null : Number(step.completed_at) })) });
  }

  async claim(turnId: string) {
    const client = await this.database.pool.connect();
    try {
      await client.query('BEGIN'); const turn = await client.query('SELECT story_id,status FROM story_turns WHERE id=$1 FOR UPDATE', [turnId]); if (!turn.rows.length || !['queued', 'narrating', 'summarizing'].includes(turn.rows[0].status)) { await client.query('ROLLBACK'); return null; }
      const story = await client.query('SELECT running_turn_id FROM stories WHERE id=$1 FOR UPDATE', [turn.rows[0].story_id]);
      if (story.rows[0].running_turn_id && story.rows[0].running_turn_id !== turnId) { await client.query('ROLLBACK'); return { busy: true as const, storyId: turn.rows[0].story_id as string, phase: turn.rows[0].status as TurnStatus }; }
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

  async resolveChoice(storyId: string, choice: string) {
    const client = await this.database.pool.connect();
    try {
      await client.query('BEGIN'); const turn = await client.query("SELECT id FROM story_turns WHERE story_id=$1 AND status='waiting_player' ORDER BY created_at DESC LIMIT 1 FOR UPDATE", [storyId]); if (!turn.rows.length) throw new Error('WAITING_CHOICE_NOT_FOUND');
      const proposal = await client.query("SELECT id FROM stage_proposals WHERE story_id=$1 AND status='pending' LIMIT 1", [storyId]); if (proposal.rows.length) throw new Error('STAGE_PROPOSAL_REQUIRES_REVIEW');
      const story = await client.query('SELECT clock FROM stories WHERE id=$1 FOR UPDATE', [storyId]); const id = randomUUID(), seq = await this.nextFact(client, storyId);
      await client.query('INSERT INTO facts(id,story_id,seq,time,kind,text,tags,visibility,source_turn_id,payload,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)', [id, storyId, seq, Number(story.rows[0].clock), 'action', `玩家选择：${choice}`, ['player_choice'], 'player', turn.rows[0].id, { type: 'player_choice', choice }, Date.now()]);
      await client.query("UPDATE story_turns SET status='completed',current_step='completed',waiting_reason=NULL,updated_at=$2 WHERE id=$1", [turn.rows[0].id, Date.now()]); await client.query('UPDATE stories SET revision=revision+1,updated_at=$2 WHERE id=$1', [storyId, Date.now()]); await client.query('COMMIT'); return { turnId: turn.rows[0].id, factId: id, choice };
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }

  private async nextFact(client: PoolClient, storyId: string) { const result = await client.query('UPDATE stories SET fact_seq=fact_seq+1 WHERE id=$1 RETURNING fact_seq', [storyId]); return Number(result.rows[0].fact_seq); }

  async commitScene(turnId: string, planInput: ScenePlan) {
    const plan = scenePlanSchema.parse(planInput); const client = await this.database.pool.connect();
    try {
      await client.query('BEGIN'); const turn = await client.query('SELECT * FROM story_turns WHERE id=$1 FOR UPDATE', [turnId]); if (!turn.rows.length) throw new Error('TURN_NOT_FOUND');
      const storyId = turn.rows[0].story_id; const story = await client.query('SELECT * FROM stories WHERE id=$1 FOR UPDATE', [storyId]); const startTime = Number(story.rows[0].clock); const endTime = startTime + plan.durationMinutes;
      const characterRows = await client.query('SELECT id,data FROM characters WHERE story_id=$1 FOR UPDATE', [storyId]); const characters = new Map(characterRows.rows.map(row => [row.id, characterSchema.parse(row.data)])); const factIds: string[] = []; let major = plan.requiresPlayerChoice;
      const addFact = async (kind: CanonicalFact['kind'], text: string, tags: string[], visibility: CanonicalFact['visibility'] = 'player', payload: Record<string, unknown> | null = null) => {
        const id = randomUUID(), seq = await this.nextFact(client, storyId); await client.query('INSERT INTO facts(id,story_id,seq,time,kind,text,tags,visibility,source_turn_id,payload,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)', [id, storyId, seq, endTime, kind, text, tags, visibility, turnId, payload, Date.now()]); factIds.push(id); return id;
      };
      for (const change of plan.changes) {
        if (change.type === 'character') {
          const character = characters.get(change.characterId); if (!character) throw new Error(`UNKNOWN_CHARACTER:${change.characterId}`); major ||= change.significance === 'major';
          if (change.field === 'hook') character.unresolvedHooks = [...character.unresolvedHooks, change.value].slice(-12); else character[change.field] = change.value;
          character.lastSceneSeq += 1; character.version += 1; await client.query('UPDATE characters SET data=$3 WHERE story_id=$1 AND id=$2', [storyId, character.id, character]);
          await addFact('character', `${character.name}：${change.value}`, ['character', character.id, change.field], 'player', { type: 'character', change });
        } else if (change.type === 'relationship') {
          major ||= change.significance === 'major'; let found = await client.query('SELECT id,data FROM relationships WHERE story_id=$1 AND from_id=$2 AND to_id=$3 FOR UPDATE', [storyId, change.from, change.to]);
          if (!found.rows.length) found = await client.query('SELECT id,data FROM relationships WHERE story_id=$1 AND from_id=$3 AND to_id=$2 FOR UPDATE', [storyId, change.from, change.to]);
          let relation: Relationship;
          if (found.rows.length) relation = relationshipSchema.parse(found.rows[0].data); else relation = relationshipSchema.parse({ id: randomUUID(), from: change.from, to: change.to, trust: 0, affinity: 0, tension: 0, summary: '', evidenceFactIds: [], version: 1 });
          relation[change.dimension] = Math.max(change.dimension === 'tension' ? 0 : -100, Math.min(100, relation[change.dimension] + change.delta)); relation.summary = change.reason; relation.version += 1;
          const factId = await addFact('relationship', change.reason, ['relationship', change.from, change.to], 'player', { type: 'relationship', change }); relation.evidenceFactIds = [...relation.evidenceFactIds, factId].slice(-30);
          if (found.rows.length) await client.query('UPDATE relationships SET data=$2 WHERE id=$1', [relation.id, relation]); else await client.query('INSERT INTO relationships(id,story_id,from_id,to_id,data) VALUES($1,$2,$3,$4,$5)', [relation.id, storyId, relation.from, relation.to, relation]);
        } else await addFact(change.kind, change.text, change.tags, 'player', { type: 'fact', change });
      }
      await addFact('action', plan.objective, ['scene', ...plan.participants], 'player', { type: 'scene_action', objective: plan.objective, participants: plan.participants });
      let stageTransition = false; const stageResult = await client.query('SELECT id,position,data FROM story_stages WHERE id=$1 FOR UPDATE', [story.rows[0].active_stage_id]);
      if (stageResult.rows.length) {
        const stage = storyStageSchema.parse(stageResult.rows[0].data); stage.progress = Math.min(100, stage.progress + plan.stageProgressDelta); stage.revision += 1;
        if (stage.progress >= 100) {
          stage.status = 'completed'; stageTransition = true; const next = await client.query('SELECT id,data FROM story_stages WHERE story_id=$1 AND position=$2', [storyId, stage.position + 1]);
          if (next.rows.length) await client.query('INSERT INTO stage_proposals(id,story_id,stage_id,status,reason,created_at) VALUES($1,$2,$3,$4,$5,$6)', [randomUUID(), storyId, next.rows[0].id, 'pending', `阶段“${stage.title}”已完成，建议进入“${next.rows[0].data.title}”。`, Date.now()]);
          await addFact('stage', `阶段“${stage.title}”已完成。`, ['stage', stage.id], 'player', { type: 'stage_completed', stageId: stage.id });
        }
        await client.query('UPDATE story_stages SET data=$2 WHERE id=$1', [stage.id, stage]);
        await addFact('stage', `阶段“${stage.title}”进度更新为 ${stage.progress}%。`, ['stage', stage.id, 'progress'], 'player', { type: 'stage_progress', stageId: stage.id, progress: stage.progress, status: stage.status, revision: stage.revision });
      }
      const count = await client.query('SELECT count(*)::int AS count FROM scenes WHERE story_id=$1', [storyId]); const scene = sceneSchema.parse({ id: randomUUID(), turnId, seq: Number(count.rows[0].count) + 1, startTime, endTime, location: plan.location, title: plan.title, prose: '场景叙事正在生成。', summary: plan.objective, participants: plan.participants, factIds, choices: [] });
      await client.query('INSERT INTO scenes(id,story_id,turn_id,seq,start_time,end_time,data,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)', [scene.id, storyId, turnId, scene.seq, startTime, endTime, scene, Date.now()]);
      const waiting = major || stageTransition; const reason = stageTransition ? '阶段已结算，请审核下一阶段提案。' : major ? (plan.choicePrompt ?? '出现重大选择，需要玩家决定。') : null;
      await client.query('UPDATE stories SET clock=$2,revision=revision+1,updated_at=$3 WHERE id=$1', [storyId, endTime, Date.now()]);
      await client.query("UPDATE story_turns SET status='narrating',current_step='narrating',waiting_reason=$2,updated_at=$3 WHERE id=$1", [turnId, reason, Date.now()]); await client.query('COMMIT');
      return { scene, waiting, reason, stageTransition };
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }

  async finalizeNarration(turnId: string, narrationInput: Narration) {
    const narration = narrationSchema.parse(narrationInput); const client = await this.database.pool.connect();
    try {
      await client.query('BEGIN'); const turn = await client.query('SELECT story_id,status,waiting_reason FROM story_turns WHERE id=$1 FOR UPDATE', [turnId]);
      if (!turn.rows.length || turn.rows[0].status !== 'narrating') throw new Error('TURN_NOT_READY_FOR_NARRATION');
      const result = await client.query('SELECT id,data FROM scenes WHERE turn_id=$1 FOR UPDATE', [turnId]); if (!result.rows.length) throw new Error('SCENE_NOT_FOUND');
      const scene = sceneSchema.parse({ ...result.rows[0].data, title: narration.title, prose: narration.prose, summary: narration.summary, choices: narration.choices });
      await client.query('UPDATE scenes SET data=$2 WHERE id=$1', [scene.id, scene]);
      const waiting = !!turn.rows[0].waiting_reason;
      await client.query("UPDATE story_turns SET status='summarizing',current_step='summarizing',updated_at=$2 WHERE id=$1", [turnId, Date.now()]);
      await client.query('COMMIT'); return { scene, waiting, reason: turn.rows[0].waiting_reason as string | null };
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }

  async completeTurn(turnId: string) {
    const client = await this.database.pool.connect();
    try {
      await client.query('BEGIN'); const turn = await client.query('SELECT story_id,waiting_reason,status FROM story_turns WHERE id=$1 FOR UPDATE', [turnId]);
      if (!turn.rows.length || turn.rows[0].status !== 'summarizing') throw new Error('TURN_NOT_READY_TO_COMPLETE');
      const waiting = !!turn.rows[0].waiting_reason;
      await client.query('UPDATE story_turns SET status=$2,current_step=$2,updated_at=$3 WHERE id=$1', [turnId, waiting ? 'waiting_player' : 'completed', Date.now()]);
      await client.query('UPDATE stories SET running_turn_id=NULL,revision=revision+1,updated_at=$2 WHERE id=$1', [turn.rows[0].story_id, Date.now()]);
      await client.query('COMMIT'); return { waiting, reason: turn.rows[0].waiting_reason as string | null };
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }

  async createAutoplay(storyId: string, request: AutoplayRequest) {
    const current = await this.database.pool.query("SELECT data FROM autoplay_sessions WHERE story_id=$1 AND data->>'status'='running'", [storyId]); if (current.rows.length) throw new Error('AUTOPLAY_ALREADY_RUNNING');
    const story = await this.database.pool.query('SELECT clock FROM stories WHERE id=$1', [storyId]); if (!story.rows.length) throw new Error('STORY_NOT_FOUND'); const startTime = Number(story.rows[0].clock);
    const session = autoplaySessionSchema.parse({ id: randomUUID(), storyId, durationMinutes: request.durationMinutes, maxScenes: request.maxScenes, startTime, targetTime: startTime + request.durationMinutes, scenes: 0, status: 'running', pauseReason: null });
    await this.database.pool.query('INSERT INTO autoplay_sessions(id,story_id,data,created_at,updated_at) VALUES($1,$2,$3,$4,$4)', [session.id, storyId, session, Date.now()]); return session;
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

  async pendingProposal(storyId: string) { const { rows } = await this.database.pool.query("SELECT p.id,p.stage_id,p.reason,s.data FROM stage_proposals p JOIN story_stages s ON s.id=p.stage_id WHERE p.story_id=$1 AND p.status='pending' ORDER BY p.created_at LIMIT 1", [storyId]); return rows[0] ? { id: rows[0].id, stageId: rows[0].stage_id, reason: rows[0].reason, stage: storyStageSchema.parse(rows[0].data) } : null; }
  async closeStageAtBoundary(storyId: string, boundaryTime: number, sourceTurnId: string) {
    const client = await this.database.pool.connect();
    try {
      await client.query('BEGIN'); const story = await client.query('SELECT clock,active_stage_id FROM stories WHERE id=$1 FOR UPDATE', [storyId]); if (!story.rows.length || Number(story.rows[0].clock) < boundaryTime) { await client.query('ROLLBACK'); return null; }
      const existing = await client.query("SELECT id FROM stage_proposals WHERE story_id=$1 AND status='pending' LIMIT 1", [storyId]); if (existing.rows.length) { await client.query('ROLLBACK'); return this.pendingProposal(storyId); }
      const current = await client.query('SELECT id,position,data FROM story_stages WHERE id=$1 FOR UPDATE', [story.rows[0].active_stage_id]); if (!current.rows.length) { await client.query('ROLLBACK'); return null; }
      const stage = storyStageSchema.parse(current.rows[0].data); if (stage.status !== 'active') { await client.query('ROLLBACK'); return null; }
      const next = await client.query('SELECT id,data FROM story_stages WHERE story_id=$1 AND position=$2', [storyId, stage.position + 1]); if (!next.rows.length) { await client.query('ROLLBACK'); return null; }
      const progressBeforeBoundary = stage.progress; stage.progress = 100; stage.status = 'completed'; stage.revision += 1; await client.query('UPDATE story_stages SET data=$2 WHERE id=$1', [stage.id, stage]);
      const proposalId = randomUUID(); const reason = `阶段“${stage.title}”已到故事时间边界（${boundaryTime} 分钟），以 ${progressBeforeBoundary}% 的已取得进展结算；请审核是否进入“${next.rows[0].data.title}”。`;
      await client.query('INSERT INTO stage_proposals(id,story_id,stage_id,status,reason,created_at) VALUES($1,$2,$3,$4,$5,$6)', [proposalId, storyId, next.rows[0].id, 'pending', reason, Date.now()]); const seq = await this.nextFact(client, storyId); const factId = randomUUID();
      await client.query('INSERT INTO facts(id,story_id,seq,time,kind,text,tags,visibility,source_turn_id,payload,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)', [factId, storyId, seq, boundaryTime, 'stage', `阶段“${stage.title}”在时间边界结算，等待玩家审核下一阶段。`, ['stage', stage.id, 'time_boundary'], 'player', sourceTurnId, { type: 'stage_boundary', stageId: stage.id, boundaryTime, progressBeforeBoundary, progress: stage.progress, status: stage.status, revision: stage.revision }, Date.now()]);
      await client.query('UPDATE stories SET revision=revision+1,updated_at=$2 WHERE id=$1', [storyId, Date.now()]); await client.query('COMMIT'); return { id: proposalId, stageId: next.rows[0].id, reason, stage: storyStageSchema.parse(next.rows[0].data) };
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }
  async reviewProposal(storyId: string, proposalId: string, decision: 'accept' | 'reject') {
    const client = await this.database.pool.connect(); try { await client.query('BEGIN'); const result = await client.query("SELECT * FROM stage_proposals WHERE id=$1 AND story_id=$2 AND status='pending' FOR UPDATE", [proposalId, storyId]); if (!result.rows.length) throw new Error('PROPOSAL_NOT_FOUND');
      await client.query('UPDATE stage_proposals SET status=$2,reviewed_at=$3 WHERE id=$1', [proposalId, decision === 'accept' ? 'accepted' : 'rejected', Date.now()]);
      if (decision === 'accept') {
        const stage = await client.query('SELECT data FROM story_stages WHERE id=$1 FOR UPDATE', [result.rows[0].stage_id]); const data = storyStageSchema.parse(stage.rows[0].data); data.status = 'active'; data.revision += 1; await client.query('UPDATE story_stages SET data=$2 WHERE id=$1', [data.id, data]);
        const story = await client.query('SELECT clock FROM stories WHERE id=$1 FOR UPDATE', [storyId]); const seq = await this.nextFact(client, storyId); const factId = randomUUID();
        await client.query('INSERT INTO facts(id,story_id,seq,time,kind,text,tags,visibility,source_turn_id,payload,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)', [factId, storyId, seq, Number(story.rows[0].clock), 'stage', `玩家确认进入阶段“${data.title}”。`, ['stage', data.id, 'accepted'], 'player', proposalId, { type: 'stage_accepted', stageId: data.id, revision: data.revision }, Date.now()]);
        await client.query('UPDATE stories SET active_stage_id=$2,revision=revision+1,updated_at=$3 WHERE id=$1', [storyId, data.id, Date.now()]);
      }
      await client.query('COMMIT'); return { accepted: decision === 'accept' };
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }

  async editStage(storyId: string, stageInput: StoryStage) { const stage = storyStageSchema.parse(stageInput); const exists = await this.database.pool.query('SELECT id FROM story_stages WHERE id=$1 AND story_id=$2', [stage.id, storyId]); if (!exists.rows.length) throw new Error('STAGE_NOT_FOUND'); stage.revision += 1; await this.database.pool.query('UPDATE story_stages SET data=$2 WHERE id=$1', [stage.id, stage]); await this.database.pool.query('UPDATE stories SET revision=revision+1,updated_at=$2 WHERE id=$1', [storyId, Date.now()]); return stage; }

  async ensureNoProcessing(storyId: string) { const { rows } = await this.database.pool.query('SELECT id FROM story_turns WHERE story_id=$1 AND status=ANY($2::text[]) LIMIT 1', [storyId, processing]); return !rows.length; }

  async stateHashes(storyId: string) {
    const [storyResult, stageResult, characterResult, relationshipResult, factResult, sceneResult] = await Promise.all([
      this.database.pool.query('SELECT outline,clock,active_stage_id FROM stories WHERE id=$1', [storyId]),
      this.database.pool.query('SELECT data FROM story_stages WHERE story_id=$1 ORDER BY position', [storyId]),
      this.database.pool.query("SELECT data FROM characters WHERE story_id=$1 ORDER BY id", [storyId]),
      this.database.pool.query('SELECT data FROM relationships WHERE story_id=$1 ORDER BY from_id,to_id', [storyId]),
      this.database.pool.query('SELECT id,seq,source_turn_id,payload FROM facts WHERE story_id=$1 ORDER BY seq', [storyId]),
      this.database.pool.query('SELECT data FROM scenes WHERE story_id=$1 ORDER BY seq', [storyId]),
    ]);
    if (!storyResult.rows.length) throw new Error('STORY_NOT_FOUND'); const story = storyResult.rows[0]; const outline = outlineDraftSchema.parse(story.outline);
    const stages = stageResult.rows.map(row => storyStageSchema.parse(row.data)); const characters = characterResult.rows.map(row => characterSchema.parse(row.data)); const relationships = relationshipResult.rows.map(row => relationshipSchema.parse(row.data)); const scenes = sceneResult.rows.map(row => sceneSchema.parse(row.data));
    const mutableCharacter = (character: Character) => ({ id: character.id, mood: character.mood, condition: character.condition, location: character.location, currentGoal: character.currentGoal, recentBeat: character.recentBeat, unresolvedHooks: character.unresolvedHooks, lastSceneSeq: character.lastSceneSeq, version: character.version });
    const mutableRelation = (relation: Relationship) => ({ from: relation.from, to: relation.to, trust: relation.trust, affinity: relation.affinity, tension: relation.tension, summary: relation.summary, evidenceFactIds: relation.evidenceFactIds, version: relation.version });
    const snapshot = (value: { clock: number; activeStageId: string | null; stages: StoryStage[]; characters: Character[]; relationships: Relationship[] }) => ({
      clock: value.clock, activeStageId: value.activeStageId,
      stages: value.stages.map(stage => ({ id: stage.id, position: stage.position, status: stage.status, progress: stage.progress, revision: stage.revision })),
      characters: value.characters.map(mutableCharacter).sort((a, b) => a.id.localeCompare(b.id)), relationships: value.relationships.map(mutableRelation).sort((a, b) => `${a.from}:${a.to}`.localeCompare(`${b.from}:${b.to}`)),
      facts: factResult.rows.map(row => ({ id: row.id, seq: Number(row.seq), sourceTurnId: row.source_turn_id })), scenes: scenes.map(scene => ({ id: scene.id, turnId: scene.turnId, seq: scene.seq, endTime: scene.endTime, factIds: scene.factIds })),
    });
    const actual = snapshot({ clock: Number(story.clock), activeStageId: story.active_stage_id, stages, characters, relationships });
    const replayStages = stages.map((stage, position) => storyStageSchema.parse({ ...stage, status: position === 0 ? 'active' : 'planned', progress: 0, revision: 1 }));
    const replayCharacters = outline.characters.map(character => characterSchema.parse({ ...character, mood: '平静', condition: '状态稳定', currentGoal: character.drives[0] ?? '', recentBeat: '故事尚未开始', unresolvedHooks: [], lastSceneSeq: 0, spotlight: character.importance === 'protagonist' ? 100 : character.importance === 'core' ? 80 : 40, version: 1 }));
    const protagonist = replayCharacters.find(character => character.importance === 'protagonist')!;
    const replayRelationships = replayCharacters.filter(character => character.id !== protagonist.id).map(character => relationshipSchema.parse({ id: randomUUID(), from: protagonist.id, to: character.id, trust: 0, affinity: 0, tension: 0, summary: '关系将在故事中形成', evidenceFactIds: [], version: 1 }));
    let activeStageId: string | null = replayStages[0]?.id ?? null;
    for (const fact of factResult.rows) {
      const payload = fact.payload as any; if (!payload?.type) continue;
      if (payload.type === 'character') {
        const change = payload.change; const character = replayCharacters.find(item => item.id === change.characterId); if (!character) continue;
        if (change.field === 'hook') character.unresolvedHooks = [...character.unresolvedHooks, change.value].slice(-12); else (character as any)[change.field] = change.value; character.lastSceneSeq += 1; character.version += 1;
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
    const replay = snapshot({ clock: scenes.at(-1)?.endTime ?? 0, activeStageId, stages: replayStages, characters: replayCharacters, relationships: replayRelationships });
    const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
    return { stateHash: hash(actual), replayHash: hash(replay), matches: hash(actual) === hash(replay) };
  }
}
