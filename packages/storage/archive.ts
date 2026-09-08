import {checkNarrativeEvidence} from '../agent-runtime/narrative-evidence.ts';
import {narrationSchema} from '../contracts/index.ts';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { StoryStore } from './store.ts';
import { digest, saveTables, unpackCheckpoint, parseStoredFact } from './experience-store.ts';
import { characterSchema, decisionSchema, factSchema, relationshipSchema, sceneSchema, storyStageSchema, storyWorldConfigSchema, outlineDraftSchema } from '../contracts/index.ts';
import { experienceStateSchema } from '../contracts/experience.ts';
import { StoryConflict } from './errors.ts';

const archiveSchema = z.object({ format: z.literal('srpg'), formatVersion: z.literal(1), checkpointId: z.string().uuid(), hash: z.string().length(64), snapshot: z.object({ story: z.record(z.string(), z.unknown()), tables: z.record(z.string(), z.array(z.record(z.string(), z.unknown()))) }), sceneSeq: z.number().int().min(0), factSeq: z.number().int().min(0) }).strict();
const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const literalKeys = new Set(['text','prose','summary','title','objective','reason','input','choice','choicePrompt','publicProfile','privateProfile','advancedPrompt','premise','tone','quote','sourceQuotes','error','waiting_reason','currentGoal','recentBeat','location','condition','mood','label','result','fingerprint','key','idempotency_key']);
function collectIds(value: any, ids: Set<string>, key = '') {
  if (literalKeys.has(key) && (typeof value==='string'||Array.isArray(value))) return;
  if (typeof value === 'string') { if (uuidPattern.test(value)) ids.add(value); }
  else if (Array.isArray(value)) value.forEach(v => collectIds(v,ids,key));
  else if (value && typeof value === 'object') Object.entries(value).forEach(([k,v]) => collectIds(v,ids,k));
}
function remap(value: any, mapping: Map<string,string>, key = ''): any {
  if (literalKeys.has(key) && (typeof value==='string'||Array.isArray(value))) return value;
  if (typeof value === 'string') return mapping.get(value) ?? value;
  if (Array.isArray(value)) return value.map(v => remap(v,mapping,key));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k,v]) => [k,remap(v,mapping,k)]));
  return value;
}

export class StoryArchive {
  constructor(readonly store: StoryStore) {}
  async export(storyId: string, checkpointId?: string) {
    const row = (await this.store.database.pool.query(`SELECT * FROM story_checkpoints WHERE story_id=$1 ${checkpointId ? 'AND id=$2' : ''} ORDER BY scene_seq DESC,fact_seq DESC,created_at DESC,id DESC LIMIT 1`, checkpointId ? [storyId,checkpointId] : [storyId])).rows[0];
    if (!row) throw new StoryConflict('CHECKPOINT_UNAVAILABLE');
    return { format: 'srpg' as const, formatVersion: 1 as const, checkpointId: row.id, hash: row.hash, snapshot: unpackCheckpoint(row.data), sceneSeq: Number(row.scene_seq), factSeq: Number(row.fact_seq) };
  }
  validate(input: unknown) {
    const archive = archiveSchema.parse(input); const snapshot = archive.snapshot as { story: any; tables: Record<string,any[]> };
    if (digest(snapshot) !== archive.hash) throw new StoryConflict('ARCHIVE_HASH_MISMATCH');
    if (Number(snapshot.story.schema_version) > 7 || Number(snapshot.story.schema_version) < 2) throw new StoryConflict('UNSUPPORTED_SAVE_VERSION');
    storyWorldConfigSchema.parse(snapshot.story.config); outlineDraftSchema.parse(snapshot.story.outline);
    for (const table of saveTables) {
      if(!snapshot.tables[table]&&Number(snapshot.story.schema_version)<({story_experience:3,resource_attempts:6,npc_batches:7} as Record<string,number>)[table])snapshot.tables[table]=[];
      if (!Array.isArray(snapshot.tables[table])) throw new StoryConflict('INCOMPLETE_ARCHIVE');
      if (snapshot.tables[table].some(row => row.story_id !== snapshot.story.id)) throw new StoryConflict('CROSS_STORY_ARCHIVE');
      const seen = new Set<string>(); for (const row of snapshot.tables[table]) { const key = String(row.id ?? row.turn_id ?? row.story_id); if (seen.has(key)) throw new StoryConflict('DUPLICATE_ARCHIVE_ROW'); seen.add(key); }
    }
    snapshot.tables.characters.forEach(r => characterSchema.parse(r.data)); snapshot.tables.relationships.forEach(r => relationshipSchema.parse(r.data)); snapshot.tables.story_stages.forEach(r => storyStageSchema.parse(r.data)); snapshot.tables.story_decisions.forEach(r => decisionSchema.parse(r.data)); snapshot.tables.scenes.forEach(r => sceneSchema.parse(r.data)); snapshot.tables.story_experience.forEach(r => experienceStateSchema.parse(r.data));
    if(archive.sceneSeq!==Math.max(0,...snapshot.tables.scenes.map(r=>Number(r.seq)))||archive.factSeq!==Number(snapshot.story.fact_seq)||archive.factSeq!==Math.max(0,...snapshot.tables.facts.map(r=>Number(r.seq))))throw new StoryConflict('CHECKPOINT_BOUNDARY_MISMATCH');
    const facts = new Set(snapshot.tables.facts.map(r => r.id)), turns = new Set(snapshot.tables.story_turns.map(r => r.id)), stages = new Set(snapshot.tables.story_stages.map(r => r.id));
    for (const row of snapshot.tables.facts){const fact=parseStoredFact(row),change=fact.payload?.change as any;if(fact.payload?.type==='fact'&&change&&(change.text!==fact.text||change.kind!==fact.kind||digest(change.tags)!==digest(fact.tags)))throw new StoryConflict('FACT_PAYLOAD_MISMATCH');}
    for(const row of snapshot.tables.scenes){const scene=sceneSchema.parse(row.data);if(scene.published&&scene.claims.length){const facts=snapshot.tables.facts.filter(f=>scene.factIds.includes(f.id)).map(parseStoredFact);const {title,prose,summary,choices,claims,segments}=scene;if(checkNarrativeEvidence(narrationSchema.parse({title,prose,summary,choices,claims,segments}),facts).length)throw new StoryConflict('INVALID_SAVED_NARRATIVE_REFERENCES');}}
    for (const scene of snapshot.tables.scenes) if(scene.id!==scene.data.id||scene.turn_id!==scene.data.turnId||scene.seq!==scene.data.seq)throw new StoryConflict('SCENE_ROW_MISMATCH');
    for (const scene of snapshot.tables.scenes) if (!turns.has(scene.turn_id) || scene.data.factIds.some((id:string) => !facts.has(id))) throw new StoryConflict('BROKEN_SCENE_REFERENCE');
    for (const row of snapshot.tables.stage_proposals) if (!stages.has(row.stage_id)) throw new StoryConflict('BROKEN_STAGE_REFERENCE');
    const checkRefs = (value: any, key = '') => {
      if (['factIds','evidenceFactIds','triggerFactIds'].includes(key) && Array.isArray(value) && value.some(id => !facts.has(id))) throw new StoryConflict('BROKEN_FACT_REFERENCE');
      if (['factId','warningFactId'].includes(key) && value && !facts.has(value)) throw new StoryConflict('BROKEN_FACT_REFERENCE');
      if (literalKeys.has(key)) return;
      if (Array.isArray(value)) value.forEach(v => checkRefs(v)); else if (value && typeof value === 'object') Object.entries(value).forEach(([k,v]) => checkRefs(v,k));
    };
    checkRefs(snapshot);
    return archive;
  }
  async import(owner: string, input: unknown, idempotencyKey: string, lineage?: { storyId: string; checkpointId: string }) {
    const archive = this.validate(input); const old = archive.snapshot as any;
    const requestHash = digest({ hash: archive.hash, lineage });
    const client = await this.store.database.pool.connect();
    try {
      await client.query('BEGIN'); await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`import:${owner}:${idempotencyKey}`]);
      const prior = (await client.query('SELECT * FROM archive_requests WHERE owner=$1 AND key=$2', [owner,idempotencyKey])).rows[0];
      if (prior) { if (prior.hash !== requestHash) throw new StoryConflict('IDEMPOTENCY_CONFLICT'); await client.query('COMMIT'); return prior.response; }
      const ids = new Set<string>(); collectIds(old,ids);
      // Logical actors, graph nodes and item identities remain stable across independent saves.
      const logical=new Set<string>(old.tables.characters.map((r:any)=>r.id));for(const stage of old.story.outline.stages){if(stage.nodeId)logical.add(stage.nodeId);for(const mid of stage.milestoneIds??[])logical.add(mid);}const resource=old.tables.story_experience[0]?.data.resources;for(const item of resource?.items??[])logical.add(item.id);for(const challenge of resource?.challenges??[])logical.add(challenge.id);for(const key of logical)ids.delete(key);
      const mapping = new Map([...ids].map(id => [id,randomUUID()]));
      const value = remap(old,mapping); const id = mapping.get(old.story.id)!; const now = Date.now();
      // A frozen quote hashes the physical IDs in its input state. Rebase only
      // hashes whose complete source state is present; keep the original roll.
      const resourceHashes=new Map<string,string>();
      const recordResource=(state:any)=>{if(state)resourceHashes.set(digest(state),digest(remap(state,mapping)));};
      for(const row of old.tables.story_experience)recordResource(row.data.resources);
      for(const row of old.tables.resource_attempts)recordResource(row.data.resolved?.state);
      for(const row of old.tables.npc_batches)for(const prepared of Object.values(row.data.prepared??{}) as any[])recordResource(prepared.resolved?.state);
      for(const row of value.tables.resource_attempts)row.data.before=resourceHashes.get(row.data.before)??row.data.before;
      for(const row of value.tables.npc_batches)for(const prepared of Object.values(row.data.prepared??{}) as any[])prepared.before=resourceHashes.get(prepared.before)??prepared.before;
      value.story.id = id; value.story.owner = owner; value.story.branch = lineage ? `分支-${id.slice(0,8)}` : `恢复-${id.slice(0,8)}`;
      value.story.running_turn_id = null; value.story.created_at = now; value.story.updated_at = now;
      const insert = async (table:string,row:Record<string,unknown>) => {
        const columns = (await client.query('SELECT column_name FROM information_schema.columns WHERE table_schema=\'public\' AND table_name=$1', [table])).rows.map(r => r.column_name);
        const names = Object.keys(row); if (names.some(name => !columns.includes(name))) throw new StoryConflict('UNKNOWN_ARCHIVE_FIELD');
        await client.query(`INSERT INTO ${table}(${names.map(n => `"${n}"`).join(',')}) VALUES(${names.map((_,i) => `$${i+1}`).join(',')})`, names.map(name => row[name]));
      };
      await insert('stories',value.story);
      for (const table of saveTables) for (const row of value.tables[table]) {
        if (table === 'story_turns') {
          row.import_suspended = !['completed','waiting_player'].includes(row.status);
          if (row.import_suspended) { row.error = '存档恢复后暂停，请手动恢复本回合。'; if (!value.tables.scenes.some((s:any) => s.turn_id === row.id)) row.status = 'failed'; }
          if (typeof row.idempotency_key === 'string' && row.idempotency_key.startsWith('decision:')) row.idempotency_key = `decision:${row.decision_id}`;
        }
        if(table==='story_turns'&&row.idempotency_key?.startsWith('autoplay:')){const parts=row.idempotency_key.split(':');parts[1]=mapping.get(parts[1])??parts[1];row.idempotency_key=parts.join(':');}
        if (table === 'autoplay_sessions') {
          const oldSession = old.tables.autoplay_sessions.find((s:any) => mapping.get(s.id) === row.id);
          if (row.data.status === 'running') row.data.status = 'paused'; row.data.pauseReason = '恢复后等待玩家继续';
          row.data.scenes = old.tables.story_turns.filter((t:any) => t.idempotency_key.startsWith(`autoplay:${oldSession.id}:`) && ['completed','waiting_player'].includes(t.status)).length;
        }
        await insert(table,row);
      }
      for(const turn of value.tables.story_turns.filter((t:any)=>t.source==='autoplay'&&['completed','waiting_player'].includes(t.status)))await client.query('INSERT INTO story_requests(story_id,key,response) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[id,'autoplay-account:'+turn.id,{accounted:true}]);
      for (const turn of value.tables.story_turns) await client.query('INSERT INTO story_outbox(id,turn_id,dispatched,created_at) VALUES($1,$2,true,$3)', [randomUUID(),turn.id,now]);
      const hashes = await this.store.stateHashes(id,client); if (!hashes.matches) throw new StoryConflict('ARCHIVE_REPLAY_MISMATCH');
      await this.store.experience.initialize(client,id);
      await client.query('INSERT INTO story_lineage(story_id,parent_story_id,checkpoint_id,source_hash) VALUES($1,$2,$3,$4)', [id,lineage?.storyId ?? null,archive.checkpointId,archive.hash]);
      const checkpoint = await this.store.experience.checkpoint(client,id,lineage ? '分叉起点' : '恢复起点');
      const response = { storyId: id, checkpointId: checkpoint, sceneSeq: archive.sceneSeq, paused: true, sourceHash: archive.hash };
      await client.query('INSERT INTO archive_requests(owner,key,hash,response) VALUES($1,$2,$3,$4)', [owner,idempotencyKey,requestHash,response]);
      await client.query('COMMIT'); return response;
    } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  }
  async fork(owner:string,storyId:string,checkpointId:string,key:string) { return this.import(owner,await this.export(storyId,checkpointId),key,{ storyId,checkpointId }); }
}
