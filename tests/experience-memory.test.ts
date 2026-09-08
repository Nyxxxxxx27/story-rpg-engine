import { afterEach, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createActiveStory, fixture, testConfig } from './helpers.ts';
import { sceneSchema } from '../packages/contracts/index.ts';
import { layeredPrompt } from '../packages/agent-runtime/prompts.ts';
import { scenePlanSchema } from '../packages/contracts/index.ts';
import { terms } from '../packages/storage/experience-store.ts';
import { memoryExtractionSchema } from '../packages/contracts/experience.ts';
import {StoryRuntime} from '../packages/agent-runtime/runtime.ts';
import {deterministicProvider} from '../packages/agent-runtime/provider.ts';
import {storyDeterministicGenerator} from '../packages/agent-runtime/deterministic.ts';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });
it('pauses and resumes a bounded background batch without promoting an index guess to a fulfilled promise',async()=>{
  const value=await fixture();cleanups.push(value.close);const id=await createActiveStory(value),factId=randomUUID(),turnId=randomUUID(),text='程弥答应归还原件。';
  const seq=(await value.database.pool.query('UPDATE stories SET fact_seq=fact_seq+1 WHERE id=$1 RETURNING fact_seq',[id])).rows[0].fact_seq;
  await value.database.pool.query("INSERT INTO facts(id,story_id,seq,time,kind,text,tags,visibility,source_turn_id,payload,created_at) VALUES($1,$2,$3,0,'dialogue',$4,$5,'public',$6,$7,$8)",[factId,id,seq,text,['promise'],turnId,{type:'fact',change:{type:'fact',kind:'dialogue',text,tags:['promise']}},Date.now()]);let calls=0;const base=deterministicProvider(storyDeterministicGenerator);
  const runtime=new StoryRuntime(value.store,()=>({name:'deterministic',async run(role,prompt,schema,signal){if(role==='Memory Indexer'){calls++;return schema.parse({annotations:[],threads:[{id:'index-promise',kind:'promise',title:'归还原件',status:'resolved',characterIds:['core-heroine'],evidence:[{type:'fact',factId}],quote:text}]});}return base.run(role,prompt,schema,signal);}}));
  await value.store.experience.memoryStatus(id,'pause');await runtime['runMemoryBatch']();expect(calls).toBe(0);await value.store.experience.memoryStatus(id,'resume');await runtime['runMemoryBatch']();expect(calls).toBe(1);
  const indexed=await value.store.experience.state(id);expect(indexed.threads[0]).toMatchObject({status:'open',verified:false});expect((await value.store.experience.memoryStatus(id)).cursor).toBe(seq);await runtime['runMemoryBatch']();expect((await value.store.experience.memoryStatus(id)).status).toBe('completed');expect(calls).toBe(1);
  await value.store.experience.memoryStatus(id,'resume');const foreground=await value.store.enqueueTurn(id,'先处理前台','test','foreground-memory-priority');await runtime['runMemoryBatch']();expect(calls).toBe(1);await value.store.failTurn(foreground.id,'测试结束');
},60000);
it('uses proven aliases and keeps the fulfillment evidence beside an older promise',async()=>{
  const value=await fixture();cleanups.push(value.close);const id=await createActiveStory(value),context=await value.store.context(id);const actor=context.characters[1];
  const add=async(text:string,tags:string[])=>{const factId=randomUUID();const seq=(await value.database.pool.query('UPDATE stories SET fact_seq=fact_seq+1 WHERE id=$1 RETURNING fact_seq',[id])).rows[0].fact_seq;await value.database.pool.query("INSERT INTO facts(id,story_id,seq,time,kind,text,tags,visibility,source_turn_id,payload,created_at) VALUES($1,$2,$3,0,'action',$4,$5,'public',$6,$7,$8)",[factId,id,seq,text,tags,randomUUID(),{type:'fact',change:{type:'fact',kind:'action',text,tags}},Date.now()]);return factId;};
  const quote=`${actor.name}又被称为小程。中继站七号也叫七号站。${actor.name}答应归还原件。`;const promised=await add(quote,[actor.id,'promise']);await value.store.experience.indexFacts(value.database.pool,id,context.characters);
  await value.store.experience.applyMemory(value.database.pool,id,memoryExtractionSchema.parse({annotations:[{evidence:{type:'fact',factId:promised},quote,characterIds:[actor.id],aliases:[{characterId:actor.id,alias:'小程'}],locationAliases:[{name:'中继站七号',alias:'七号站'}]}],threads:[{id:'return-original',kind:'promise',title:'归还原件',status:'open',characterIds:[actor.id],evidence:[{type:'fact',factId:promised}],quote}]}),[],true);
  const fulfilledQuote=`${actor.name}已将原件归还给林序，保管承诺已履行。`,fulfilled=await add(fulfilledQuote,[actor.id]);await value.store.experience.indexFacts(value.database.pool,id,context.characters);await value.store.experience.applyMemory(value.database.pool,id,memoryExtractionSchema.parse({annotations:[],threads:[{id:'return-original',kind:'promise',title:'归还原件',status:'resolved',characterIds:[actor.id],evidence:[{type:'fact',factId:fulfilled}],quote:fulfilledQuote}]}),[],true);
  const found=await value.store.experience.retrieve(value.database.pool,id,'到七号站找小程取回旧物',context.characters,[]);expect(found.entities.find(e=>e.id===actor.id)?.aliases).toContain('小程');expect(found.threads[0].status).toBe('resolved');expect(found.facts.map(f=>f.id)).toEqual(expect.arrayContaining([promised,fulfilled]));expect(found.hits.find(h=>h.factId===promised)?.reasons).toContain(`entity:${actor.id}`);
},60000);
it('recalls an uncited promise across 200 scenes and paginates a stable history', async () => {
  const value = await fixture(); cleanups.push(value.close); const id = await createActiveStory(value);
  const state = await value.store.state(id), protagonist = state.characters[0], companion = state.characters.find(c => c.id === 'core-heroine')!;
  let promiseId = '';
  const client = await value.database.pool.connect();
  try {
    await client.query('BEGIN');
    for (let i = 1; i <= 201; i++) {
      const turnId = randomUUID(), factId = randomUUID(), sceneId = randomUUID();
      const text = i === 1 ? `${protagonist.name}答应${companion.name}：调查结束后归还航迹密钥，绝不把它送给竞争者。` : `工作人员在第${i}次巡查后关闭记录室的灯。`;
      if (i === 1) promiseId = factId;
      const seq = (await client.query('UPDATE stories SET fact_seq=fact_seq+1 WHERE id=$1 RETURNING fact_seq', [id])).rows[0].fact_seq;
      await client.query("INSERT INTO facts(id,story_id,seq,time,kind,text,tags,visibility,source_turn_id,payload,created_at) VALUES($1,$2,$3,$4,'dialogue',$5,$6,'public',$7,$8,$9)", [factId,id,seq,i,text,['history'],turnId,{ type: 'fact', change: { type: 'fact', kind: 'dialogue', text, tags: ['history'] } },Date.now()]);
      const scene = sceneSchema.parse({ id: sceneId, turnId, seq: i, startTime: i - 1, endTime: i, stageId: state.activeStage!.id, location: protagonist.location, title: `历史 ${i}`, prose: text, summary: text, participants: [protagonist.id,companion.id], factIds: [factId], choices: [] });
      await client.query('INSERT INTO scenes(id,story_id,turn_id,seq,start_time,end_time,data,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)', [sceneId,id,turnId,i,i-1,i,scene,Date.now()]);
    }
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  const context = await value.store.context(id, `与${companion.name}见面，考虑把航迹密钥赠送给竞争者。`);
  expect(context.facts.some(f => f.id === promiseId)).toBe(false);
  expect(context.evidenceFacts.some(f => f.id === promiseId)).toBe(false);
  expect(context.relevantFacts?.some(f => f.id === promiseId)).toBe(true);
  expect(layeredPrompt('Director Agent',context,'安排交接',scenePlanSchema)).toContain('绝不把它送给竞争者');
  let cursor: string | undefined, seen: number[] = [];
  do { const page = await value.store.experience.history(id,cursor); seen.push(...page.items.map(s => s.seq)); cursor = page.nextCursor ?? undefined; } while(cursor);
  expect(seen).toHaveLength(201); expect(new Set(seen).size).toBe(201); expect(seen.at(-1)).toBe(1);
  await expect(value.store.experience.history(randomUUID(), Buffer.from(JSON.stringify({ storyId:id,before:100,ceiling:201 })).toString('base64url'))).rejects.toThrow('INVALID_HISTORY_CURSOR');
}, 120000);

it('allows a romance-free outline and creates restorable decision checkpoints', async () => {
  const value = await fixture(); cleanups.push(value.close);
  const created = await value.store.create('test', { ...testConfig(), romanceMode:'off' }, 123);
  const outline = await value.runtime.generateOutline(created.storyId,'test');
  expect(outline.characters.some(c => c.roleTags.includes('love_interest'))).toBe(false);
  await value.store.confirmOutline(created.storyId,'test');
  const turn = await value.store.enqueueTurn(created.storyId,'观察记录','test','memory-checkpoint-test'); await value.runtime.runTurn(turn.id);
  expect((await value.store.turn(turn.id)).status).toBe('completed');
  expect((await value.store.experience.checkpoints(created.storyId)).length).toBeGreaterThanOrEqual(2);
  expect((await value.store.experience.chapters(created.storyId))[0].scenes).toHaveLength(1);
  expect((await value.store.experience.memoryStatus(created.storyId)).target_seq).toBe(0);
  expect(terms('旧日承诺')).toContain('承诺');
}, 60000);
