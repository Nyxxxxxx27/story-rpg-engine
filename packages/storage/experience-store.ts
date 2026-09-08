import { gzipSync, gunzipSync } from 'node:zlib';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Pool, PoolClient } from 'pg';
import { experienceStateSchema, memoryExtractionSchema, type ExperienceState, type MemoryEntity, type MemoryExtraction, type MemoryHit } from '../contracts/experience.ts';
import { outlineDraftSchema,storyWorldConfigSchema,storyStageSchema, factSchema, sceneSchema, type CanonicalFact, type Character } from '../contracts/index.ts';
import type { Database } from './database.ts';
import { StoryConflict } from './errors.ts';

type Query = Pool | PoolClient;
export const unpackCheckpoint=(data:any)=>data?.encoding==='gzip-json-v1'?JSON.parse(gunzipSync(Buffer.from(data.body,'base64')).toString('utf8')):data;
export const CURRENT_SCHEMA_VERSION = 7;
export const saveTables = ['prompt_revisions', 'story_stages', 'characters', 'relationships', 'story_turns', 'facts', 'scenes', 'stage_proposals', 'autoplay_sessions', 'story_decisions', 'story_experience', 'resource_attempts', 'npc_batches'] as const;
export const digest = (value: unknown): string => createHash('sha256').update(canonical(value)??'undefined').digest('hex');
function canonical(value: any): string { return JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item); }
export function parseStoredFact(row: any): CanonicalFact { return factSchema.parse({ id: row.id, seq: Number(row.seq), time: Number(row.time), kind: row.kind, text: row.text, tags: row.tags, visibility: row.visibility, sourceTurnId: row.source_turn_id, payload: row.payload }); }
const searchable = (fact: CanonicalFact) => ['fact', 'character', 'relationship'].includes(String(fact.payload?.type));
export function terms(text: string): string[] {
  const clean = text.toLowerCase().normalize('NFKC'); const words: string[] = clean.match(/[a-z0-9_-]+/g) ?? [];
  for (const chunk of clean.match(/[\p{Script=Han}]+/gu) ?? []) for (let i = 0; i < chunk.length - 1; i++) words.push(chunk.slice(i, i + 2));
  return [...new Set(words)].slice(0, 300);
}
export function memoryEntities(characters: Character[], names: string[]): MemoryEntity[] {
  return [...characters.map(c => ({ id: c.id, type: 'character' as const, name: c.name, aliases: [] })), ...[...new Set([...names, ...characters.map(c => c.location)])].map(name => ({ id: `loc_${digest(name).slice(0, 20)}`, type: 'location' as const, name, aliases: [] }))];
}

export class ExperienceStore {
  constructor(readonly database: Database) {}

  async setup(targetVersion = CURRENT_SCHEMA_VERSION) {
    await this.database.pool.query(`
      CREATE TABLE IF NOT EXISTS story_experience(story_id uuid PRIMARY KEY REFERENCES stories(id) ON DELETE CASCADE,data jsonb NOT NULL);
      CREATE TABLE IF NOT EXISTS memory_entities(story_id uuid NOT NULL REFERENCES stories(id) ON DELETE CASCADE,id text NOT NULL,data jsonb NOT NULL,PRIMARY KEY(story_id,id));
      CREATE TABLE IF NOT EXISTS fact_memory(story_id uuid NOT NULL REFERENCES stories(id) ON DELETE CASCADE,fact_id uuid NOT NULL REFERENCES facts(id) ON DELETE CASCADE,seq integer NOT NULL,terms text[] NOT NULL,data jsonb NOT NULL,PRIMARY KEY(story_id,fact_id));
      CREATE INDEX IF NOT EXISTS fact_memory_terms_idx ON fact_memory USING gin(terms);
      CREATE TABLE IF NOT EXISTS memory_jobs(story_id uuid PRIMARY KEY REFERENCES stories(id) ON DELETE CASCADE,status text NOT NULL DEFAULT 'running',cursor integer NOT NULL DEFAULT 0,version integer NOT NULL DEFAULT 1,error text,updated_at bigint NOT NULL);
      ALTER TABLE memory_jobs ADD COLUMN IF NOT EXISTS target_seq integer NOT NULL DEFAULT 0;
      CREATE TABLE IF NOT EXISTS memory_batches(story_id uuid NOT NULL REFERENCES stories(id) ON DELETE CASCADE,batch_key text NOT NULL,data jsonb NOT NULL,PRIMARY KEY(story_id,batch_key));
      CREATE TABLE IF NOT EXISTS story_checkpoints(id uuid PRIMARY KEY,story_id uuid NOT NULL REFERENCES stories(id) ON DELETE CASCADE,fact_seq integer NOT NULL,scene_seq integer NOT NULL,label text NOT NULL,data jsonb NOT NULL,hash text NOT NULL,created_at bigint NOT NULL,UNIQUE(story_id,hash));
      CREATE TABLE IF NOT EXISTS chapter_recaps(story_id uuid NOT NULL REFERENCES stories(id) ON DELETE CASCADE,stage_id uuid NOT NULL,source_hash text NOT NULL,data jsonb NOT NULL,PRIMARY KEY(story_id,stage_id,source_hash));
      CREATE TABLE IF NOT EXISTS experience_migrations(story_id uuid NOT NULL REFERENCES stories(id) ON DELETE CASCADE,version integer NOT NULL,data jsonb NOT NULL,PRIMARY KEY(story_id,version));
      CREATE TABLE IF NOT EXISTS turn_observations(id uuid PRIMARY KEY,story_id uuid NOT NULL REFERENCES stories(id) ON DELETE CASCADE,turn_id uuid NOT NULL,name text NOT NULL,started_at bigint NOT NULL,completed_at bigint,data jsonb NOT NULL DEFAULT '{}');
      ALTER TABLE story_turns ADD COLUMN IF NOT EXISTS import_suspended boolean NOT NULL DEFAULT false;
      ALTER TABLE story_turns ADD COLUMN IF NOT EXISTS action_intent jsonb;
      CREATE TABLE IF NOT EXISTS resource_attempts(id uuid PRIMARY KEY,story_id uuid NOT NULL REFERENCES stories(id) ON DELETE CASCADE,turn_id uuid NOT NULL UNIQUE REFERENCES story_turns(id) ON DELETE CASCADE,data jsonb NOT NULL);
      CREATE TABLE IF NOT EXISTS npc_batches(turn_id uuid PRIMARY KEY REFERENCES story_turns(id) ON DELETE CASCADE,story_id uuid NOT NULL REFERENCES stories(id) ON DELETE CASCADE,data jsonb NOT NULL);
      CREATE TABLE IF NOT EXISTS archive_requests(owner text NOT NULL,key text NOT NULL,hash text NOT NULL,response jsonb NOT NULL,PRIMARY KEY(owner,key));
      CREATE TABLE IF NOT EXISTS story_lineage(story_id uuid PRIMARY KEY REFERENCES stories(id) ON DELETE CASCADE,parent_story_id uuid,checkpoint_id uuid,source_hash text NOT NULL);
      ALTER TABLE stage_proposals ADD COLUMN IF NOT EXISTS route_id text;
      ALTER TABLE stage_proposals ADD COLUMN IF NOT EXISTS graph_revision integer;
    `);
    const stories = (await this.database.pool.query('SELECT id FROM stories WHERE schema_version<$1', [targetVersion])).rows;
    for (const { id } of stories) {
      const client = await this.database.pool.connect();
      try {
        await client.query('BEGIN'); const story = (await client.query('SELECT * FROM stories WHERE id=$1 FOR UPDATE', [id])).rows[0];
        for (let version = Number(story.schema_version) + 1; version <= targetVersion; version++) {
          const before = await this.snapshot(client, id);
          await mkdir(this.database.backupDirectory, { recursive: true });
          await writeFile(join(this.database.backupDirectory, `${id}-before-v${version}-${digest(before).slice(0, 12)}.json`), JSON.stringify(before), { flag: 'wx' }).catch((e: NodeJS.ErrnoException) => { if (e.code !== 'EEXIST') throw e; });
          await client.query('INSERT INTO experience_migrations(story_id,version,data) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [id, version, before]);
          await this.initialize(client, id);
          if(version===3){const state=await this.state(id,client);const characters=(await client.query('SELECT data FROM characters WHERE story_id=$1',[id])).rows.map(r=>r.data);const facts=(await client.query('SELECT * FROM facts WHERE story_id=$1',[id])).rows.map(parseStoredFact);for(const character of characters)for(const text of character.unresolvedHooks??[]){const key='hook_'+digest([character.id,text]).slice(0,24);if(state.threads.some(t=>t.id===key))continue;const proof=facts.filter(f=>f.payload?.type==='character'&&(f.payload.change as any)?.characterId===character.id&&(f.payload.change as any)?.field==='hook'&&(f.payload.change as any)?.value===text);state.threads.push({id:key,kind:'clue',title:text,status:'open',characterIds:[character.id],evidenceFactIds:proof.map(f=>f.id),sourceQuotes:[text],updatedSeq:Math.max(0,...proof.map(f=>f.seq)),verified:false,visibility:proof.length&&!proof.some(f=>f.visibility==='private')?'public':'private'});}await client.query('UPDATE story_experience SET data=$2 WHERE story_id=$1',[id,state]);}
          if(version===5&&story.outline&&!story.outline.graph){
            const outline=outlineDraftSchema.parse(story.outline);
            const rows=(await client.query('SELECT id,data FROM story_stages WHERE story_id=$1 ORDER BY position',[id])).rows;
            outline.stages=outline.stages.map((stage,position)=>({...stage,nodeId:'legacy_'+position,terminal:position===outline.stages.length-1}));
            outline.graph={revision:1,entry:'legacy_0',routes:outline.stages.slice(0,-1).map((stage,i)=>({id:'legacy_route_'+i,from:stage.nodeId!,to:'legacy_'+(i+1),label:'继续下一阶段',condition:null,fallback:true}))};
            for(const [index,row] of rows.entries())await client.query('UPDATE story_stages SET data=$2 WHERE id=$1',[row.id,{...row.data,nodeId:'legacy_'+index,terminal:index===rows.length-1}]);
            await client.query('UPDATE stories SET outline=$2 WHERE id=$1',[id,outline]);story.outline=outline;
            await client.query("UPDATE stage_proposals SET route_id='legacy_route_'||(s.position-1)::text,graph_revision=1 FROM story_stages s WHERE stage_proposals.story_id=$1 AND stage_proposals.stage_id=s.id",[id]);
          }
          if(version===7){
            const state=await this.state(id,client),characters=(await client.query('SELECT data FROM characters WHERE story_id=$1',[id])).rows.map(r=>r.data);
            const facts=(await client.query('SELECT * FROM facts WHERE story_id=$1 ORDER BY seq',[id])).rows.map(parseStoredFact);
            for(const fact of facts){const change=fact.payload?.change as any,observation=fact.payload?.observation as any;
              const ids=new Set<string>([...(change?.type==='character'?[change.characterId]:[]),...(observation?.witnessIds??[])]);
              for(const characterId of ids)if(characters.some(c=>c.id===characterId)&&!state.knowledge.some(k=>k.characterId===characterId&&k.factId===fact.id))state.knowledge.push({id:'knowledge_'+digest([characterId,fact.id]).slice(0,24),characterId,factId:fact.id,mode:fact.kind==='dialogue'?'reported':'observed',belief:'accepted',concealed:false,sourceCharacterId:observation?.speakerId??null,learnedAt:fact.time});
            }
            await client.query('UPDATE story_experience SET data=$2 WHERE story_id=$1',[id,state]);
          }
          await client.query('UPDATE stories SET schema_version=$2 WHERE id=$1', [id, version]);
          await this.event(client, id, { type: 'experience_migrated', version, state: await this.state(id, client), config: storyWorldConfigSchema.parse(story.config), outline: story.outline, promptVersion:Number(story.prompt_version),characters:(await client.query('SELECT data FROM characters WHERE story_id=$1',[id])).rows.map(r=>r.data),relationships:(await client.query('SELECT data FROM relationships WHERE story_id=$1',[id])).rows.map(r=>r.data),stages:(await client.query('SELECT data FROM story_stages WHERE story_id=$1 ORDER BY position',[id])).rows.map(r=>storyStageSchema.parse(r.data)),activeStageId:story.active_stage_id,storyStatus:story.status }, '存档结构已升级');
        }
        if (story.outline && !story.running_turn_id) await this.checkpoint(client, id, '迁移后的可恢复节点');
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    }
  }

  async state(storyId: string, query: Query = this.database.pool): Promise<ExperienceState> { const row = (await query.query('SELECT data FROM story_experience WHERE story_id=$1', [storyId])).rows[0]; return experienceStateSchema.parse(row?.data ?? {}); }
  async initialize(client: Query, storyId: string) {
    await client.query('INSERT INTO story_experience(story_id,data) VALUES($1,$2) ON CONFLICT DO NOTHING', [storyId, experienceStateSchema.parse({})]);
    await client.query('INSERT INTO memory_jobs(story_id,updated_at,target_seq) SELECT $1,$2,coalesce(max(seq),0) FROM facts WHERE story_id=$1 ON CONFLICT DO NOTHING', [storyId, Date.now()]);
  }
  async event(client: Query, storyId: string, payload: Record<string, unknown>, text: string, sourceId: string = randomUUID()) {
    const story = (await client.query('UPDATE stories SET fact_seq=fact_seq+1,revision=revision+1 WHERE id=$1 RETURNING fact_seq,clock', [storyId])).rows[0];
    const id = randomUUID();
    await client.query("INSERT INTO facts(id,story_id,seq,time,kind,text,tags,visibility,source_turn_id,payload,created_at) VALUES($1,$2,$3,$4,'world',$5,$6,'private',$7,$8,$9)", [id, storyId, story.fact_seq, story.clock, text, ['experience_event'], sourceId, payload, Date.now()]); return id;
  }
  async save(client: Query, storyId: string, state: ExperienceState, event: string, sourceId?: string) {
    const previous=await this.state(storyId,client);
    state.revision++;
    await client.query('INSERT INTO story_experience(story_id,data) VALUES($1,$2) ON CONFLICT(story_id) DO UPDATE SET data=excluded.data', [storyId, experienceStateSchema.parse(state)]);
    const {knowledge,...rest}=state;
    const prior=new Map(previous.knowledge.map(k=>[k.id,digest(k)]));
    const knowledgeUpdates=knowledge.filter(k=>prior.get(k.id)!==digest(k));
    const removedKnowledge=previous.knowledge.filter(k=>!knowledge.some(n=>n.id===k.id)).map(k=>k.id);
    return this.event(client,storyId,{type:'experience_delta',event,state:rest,knowledgeUpdates,removedKnowledge},event,sourceId);
  }
  async snapshot(client: Query, storyId: string) {
    const story = (await client.query('SELECT * FROM stories WHERE id=$1', [storyId])).rows[0];
    if (!story) throw new Error('STORY_NOT_FOUND');
    const tables: Record<string, any[]> = {};
    for (const table of saveTables) tables[table] = (await client.query(`SELECT * FROM ${table} WHERE story_id=$1`, [storyId])).rows;
    return { story, tables };
  }
  async checkpoint(client: Query, storyId: string, label: string) {
    const snapshot = await this.snapshot(client, storyId);
    if (!snapshot.story.outline) return null;
    delete snapshot.story.running_turn_id;
    const sceneSeq = Math.max(0, ...snapshot.tables.scenes.map(row => Number(row.seq)));
    const hash = digest(snapshot), id = randomUUID();
    const rows = (await client.query('INSERT INTO story_checkpoints(id,story_id,fact_seq,scene_seq,label,data,hash,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(story_id,hash) DO UPDATE SET hash=excluded.hash RETURNING id', [id, storyId, snapshot.story.fact_seq, sceneSeq, label, {encoding:'gzip-json-v1',body:gzipSync(JSON.stringify(snapshot)).toString('base64')}, hash, Date.now()])).rows;
    return rows[0].id as string;
  }
  async checkpoints(storyId: string) { return (await this.database.pool.query('SELECT id,fact_seq,scene_seq,label,created_at FROM story_checkpoints WHERE story_id=$1 ORDER BY scene_seq DESC,fact_seq DESC,created_at DESC,id DESC', [storyId])).rows; }

  async indexFacts(query: Query, storyId: string, characters: Character[]) {
    const rows = (await query.query('SELECT f.* FROM facts f LEFT JOIN fact_memory m ON m.story_id=f.story_id AND m.fact_id=f.id WHERE f.story_id=$1 AND m.fact_id IS NULL ORDER BY f.seq', [storyId])).rows;
    const scenes = (await query.query('SELECT data FROM scenes WHERE story_id=$1', [storyId])).rows.map(row => row.data);
    for (const entity of memoryEntities(characters, scenes.map(scene => scene.location))) await query.query('INSERT INTO memory_entities(story_id,id,data) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [storyId, entity.id, entity]);
    const entities: MemoryEntity[] = (await query.query('SELECT data FROM memory_entities WHERE story_id=$1', [storyId])).rows.map(row => row.data);
    for (const row of rows) {
      const fact = parseStoredFact(row), scene = scenes.find(scene => scene.turnId === fact.sourceTurnId);
      const linked = entities.filter(entity => [entity.name, ...entity.aliases].some(name => fact.text.includes(name)&&entities.filter(e=>[e.name,...e.aliases].includes(name)).length===1) || fact.tags.includes(entity.id) || (entity.type === 'location' && scene?.location === entity.name));
      const data = { entityIds: linked.map(e => e.id), topics: fact.tags, searchable: searchable(fact), quotes: [fact.text], origin: 'structured' };
      await query.query('INSERT INTO fact_memory(story_id,fact_id,seq,terms,data) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING', [storyId, fact.id, fact.seq, terms(`${fact.text} ${fact.tags.join(' ')}`), data]);
    }
    return entities;
  }
  async retrieve(query: Query, storyId: string, input: string, characters: Character[], recentIds: string[]) {
    const entities = await this.indexFacts(query, storyId, characters);
    const protagonist = characters.find(c => c.importance === 'protagonist');
    const text = `${input} ${protagonist?.location ?? ''}`;
    const selected = entities.filter(entity => [entity.name, ...entity.aliases, entity.id].some(name => text.includes(name)));
    const ids = new Set(selected.map(e => e.id)); const words = new Set(terms(input));
    const state = await this.state(storyId, query);
    const threads = state.threads.filter(t => t.characterIds.some(id => ids.has(id)) || terms(t.title).some(term => words.has(term))).sort((a, b) => Number(b.status === 'open') - Number(a.status === 'open') || b.updatedSeq - a.updatedSeq);
    const mandatoryIds = [...new Set(threads.slice(0, 32).flatMap(t => t.evidenceFactIds))];
    const rows = (await query.query('SELECT f.*,m.data AS memory,m.terms FROM fact_memory m JOIN facts f ON f.id=m.fact_id WHERE m.story_id=$1 AND m.data->>\'searchable\'=\'true\'', [storyId])).rows;
    const hits = rows.map(row => {
      const matchedEntities = (row.memory.entityIds as string[]).filter(id => ids.has(id));
      const overlap = (row.terms as string[]).filter(term => words.has(term)).length;
      const relevantThread = threads.find(t => t.evidenceFactIds.includes(row.id));
      const promise = /承诺|答应|保证|誓言|约定|归还|promise|swore/i.test(row.text);
      const score = matchedEntities.length * 12 + overlap * 2 + (relevantThread ? relevantThread.status === 'open' ? 24 : 10 : 0) + (promise && matchedEntities.length ? 12 : 0);
      const reasons = [...matchedEntities.map(id => `entity:${id}`), ...(overlap ? ['text'] : []), ...(relevantThread ? [`thread:${relevantThread.id}:${relevantThread.status}`] : []), ...(promise && matchedEntities.length ? ['commitment'] : [])];
      return { fact: parseStoredFact(row), hit: { factId: row.id, score, reasons } as MemoryHit };
    }).filter(item => item.hit.score > 0 && !recentIds.includes(item.fact.id)).sort((a, b) => b.hit.score - a.hit.score || a.fact.seq - b.fact.seq);
    const selectedHits = hits.slice(0, 16); const mandatory = rows.filter(row => mandatoryIds.includes(row.id)).map(parseStoredFact);
    if (JSON.stringify(mandatory).length > 80000) throw new StoryConflict('MEMORY_REQUIRED_BUDGET_EXCEEDED');
    const dedup = new Map([...mandatory, ...selectedHits.map(item => item.fact)].map(f => [f.id, f]));
    return { requiredFactIds:mandatoryIds, facts: [...dedup.values()], threads: threads.slice(0, 32), hits: selectedHits.map(item => item.hit), entities };
  }

  async applyMemory(query: Query, storyId: string, input: MemoryExtraction, changes: CanonicalFact[], verified: boolean) {
    const result = memoryExtractionSchema.parse(input), state = await this.state(storyId, query);
    const resolve = async (ref: MemoryExtraction['annotations'][number]['evidence']) => {
      const fact = ref.type === 'change' ? changes[ref.index] : (await query.query('SELECT * FROM facts WHERE story_id=$1 AND id=$2', [storyId, ref.factId])).rows.map(parseStoredFact)[0];
      if (!fact || !searchable(fact)) throw new StoryConflict('INVALID_MEMORY_EVIDENCE'); return fact;
    };
    for (const annotation of result.annotations) {
      const fact = await resolve(annotation.evidence); if (!fact.text.includes(annotation.quote)) throw new StoryConflict('MEMORY_QUOTE_MISMATCH');
      const entities = (await query.query('SELECT id,data FROM memory_entities WHERE story_id=$1', [storyId])).rows;
      if (annotation.characterIds.some(id => !entities.some(e => e.id === id && e.data.type === 'character'))) throw new StoryConflict('UNKNOWN_MEMORY_CHARACTER');
      for (const alias of annotation.aliases) {
        const entity = entities.find(e => e.id === alias.characterId)?.data as MemoryEntity | undefined;
        if (!entity || !fact.text.includes(alias.alias) || !fact.text.includes(entity.name)) continue;
        entity.aliases = [...new Set([...entity.aliases, alias.alias])]; await query.query('UPDATE memory_entities SET data=$3 WHERE story_id=$1 AND id=$2', [storyId, entity.id, entity]);
      }
      for(const alias of annotation.locationAliases){if(!fact.text.includes(alias.name)||!fact.text.includes(alias.alias))continue;const entity=entities.find(e=>e.data.type==='location'&&e.data.name===alias.name)?.data as MemoryEntity|undefined;if(entity){entity.aliases=[...new Set([...entity.aliases,alias.alias])];await query.query('UPDATE memory_entities SET data=$3 WHERE story_id=$1 AND id=$2',[storyId,entity.id,entity]);}}
      const locations:string[]=[];for(const name of annotation.locationNames){if(!fact.text.includes(name))continue;const entity=memoryEntities([], [name])[0];locations.push(entity.id);await query.query('INSERT INTO memory_entities(story_id,id,data) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[storyId,entity.id,entity]);}
      const current = (await query.query('SELECT data,terms FROM fact_memory WHERE story_id=$1 AND fact_id=$2', [storyId, fact.id])).rows[0];
      const data = { ...(current?.data ?? {}), entityIds: [...new Set([...(current?.data?.entityIds ?? []), ...annotation.characterIds,...locations])], topics: annotation.topics, searchable: true, quotes: [annotation.quote], origin: verified ? 'reviewed' : 'index_only' };
      await query.query('INSERT INTO fact_memory(story_id,fact_id,seq,terms,data) VALUES($1,$2,$3,$4,$5) ON CONFLICT(story_id,fact_id) DO UPDATE SET terms=excluded.terms,data=excluded.data', [storyId, fact.id, fact.seq, [...new Set([...(current?.terms ?? []), ...terms(`${fact.text} ${annotation.topics.join(' ')}`)])], data]);
    }
    for (const update of result.threads) {
      const facts:CanonicalFact[]=[];for(const ref of update.evidence)facts.push(await resolve(ref));
      if (!facts.some(f => f.text.includes(update.quote))) throw new StoryConflict('MEMORY_QUOTE_MISMATCH');
      const prior = state.threads.find(t => t.id === update.id);
      if (prior?.verified && !verified) continue;
      const thread = { id: update.id, kind: update.kind, title: update.title, status: verified?update.status:prior?.status??'open', characterIds: update.characterIds, evidenceFactIds: [...new Set([...(prior?.evidenceFactIds ?? []), ...facts.map(f => f.id)])], sourceQuotes: [...new Set([...(prior?.sourceQuotes ?? []), update.quote])], updatedSeq: Math.max(...facts.map(f => f.seq)), verified, visibility: facts.some(f => f.visibility === 'private') ? 'private' as const : 'public' as const };
      if (prior && prior.updatedSeq > thread.updatedSeq) continue;
      state.threads = [...state.threads.filter(t => t.id !== update.id), thread];
    }
    if (result.threads.length) await this.save(query, storyId, state, verified ? '事项证据更新' : '历史事项索引候选');
  }

  async history(storyId: string, cursor?: string, limit = 20) {
    let before = 2147483647, ceiling = 0;
    if (cursor) { try { const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString()); if (parsed.storyId !== storyId || !Number.isSafeInteger(parsed.before) || !Number.isSafeInteger(parsed.ceiling)||parsed.before<1||parsed.before>2147483647||parsed.ceiling<0||parsed.ceiling>2147483647) throw new Error(); before = parsed.before; ceiling = parsed.ceiling; } catch { throw new StoryConflict('INVALID_HISTORY_CURSOR'); } }
    else ceiling = Number((await this.database.pool.query('SELECT coalesce(max(seq),0) AS seq FROM scenes WHERE story_id=$1 AND data->>\'published\' IS DISTINCT FROM \'false\'', [storyId])).rows[0].seq);
    const rows = (await this.database.pool.query('SELECT data FROM scenes WHERE story_id=$1 AND seq<$2 AND seq<=$3 AND data->>\'published\' IS DISTINCT FROM \'false\' ORDER BY seq DESC LIMIT $4', [storyId, before, ceiling, Math.min(100, Math.max(1, limit)) + 1])).rows;
    const items = rows.slice(0, limit).map(row => sceneSchema.parse(row.data));
    return { items, ceiling, nextCursor: rows.length > limit ? Buffer.from(JSON.stringify({ storyId, before: items.at(-1)!.seq, ceiling })).toString('base64url') : null };
  }
  async scene(storyId: string, sceneId: string) { const row = (await this.database.pool.query('SELECT data FROM scenes WHERE story_id=$1 AND id=$2', [storyId, sceneId])).rows[0]; if (!row || row.data.published === false) throw new Error('SCENE_NOT_FOUND'); return sceneSchema.parse(row.data); }
  async actionPage(storyId:string,cursor?:string,before=Number.MAX_SAFE_INTEGER){
    let lastId='ffffffff-ffff-ffff-ffff-ffffffffffff';if(cursor){try{const value=JSON.parse(Buffer.from(cursor,'base64url').toString());if(value.storyId!==storyId||!Number.isSafeInteger(value.before)||!value.id?.match(/^[a-f0-9-]{36}$/i))throw new Error();before=value.before;lastId=value.id;}catch{throw new StoryConflict('INVALID_ACTION_CURSOR');}}
    const rows=(await this.database.pool.query('SELECT t.id,t.input,t.source,t.status,t.error,t.created_at,t.decision_id,d.data AS decision,s.id AS scene_id,s.seq AS scene_seq FROM story_turns t LEFT JOIN story_decisions d ON d.id=t.decision_id LEFT JOIN scenes s ON s.turn_id=t.id WHERE t.story_id=$1 AND (t.created_at,t.id)<($2,$3::uuid) ORDER BY t.created_at DESC,t.id DESC LIMIT 51',[storyId,before,lastId])).rows;
    const items=rows.slice(0,50),last=items.at(-1);return {items,nextCursor:rows.length>50?Buffer.from(JSON.stringify({storyId,before:Number(last.created_at),id:last.id})).toString('base64url'):null};
  }
  async actions(storyId:string,before=Number.MAX_SAFE_INTEGER){return (await this.actionPage(storyId,undefined,before)).items;}
  async chapters(storyId: string) {
    const stages = (await this.database.pool.query('SELECT data FROM story_stages WHERE story_id=$1 ORDER BY position', [storyId])).rows.map(r => r.data);
    const scenes = (await this.database.pool.query('SELECT data FROM scenes WHERE story_id=$1 AND data->>\'published\' IS DISTINCT FROM \'false\' ORDER BY seq', [storyId])).rows.map(r => sceneSchema.parse(r.data));
    return stages.filter(s => s.status !== 'planned').map(stage => ({ stageId: stage.id, title: stage.title, outcome: stage.outcome, scenes: scenes.filter(s => s.stageId === stage.id).map(s => ({ id: s.id, seq: s.seq, title: s.title, summary: s.summary, factIds: s.factIds })) }));
  }
  async memoryStatus(storyId: string, action?: 'pause' | 'resume') {
    if (action) await this.database.pool.query('UPDATE memory_jobs SET status=$2,error=NULL,updated_at=$3,target_seq=CASE WHEN $2=\'running\' THEN (SELECT coalesce(max(seq),0) FROM facts WHERE story_id=$1) ELSE target_seq END WHERE story_id=$1', [storyId, action === 'pause' ? 'paused' : 'running', Date.now()]);
    return (await this.database.pool.query('SELECT * FROM memory_jobs WHERE story_id=$1', [storyId])).rows[0] ?? null;
  }
}
