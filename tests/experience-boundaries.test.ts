import {afterEach,expect,it} from 'vitest';
import {fixture,testConfig} from './helpers.ts';
import {StoryArchive} from '../packages/storage/archive.ts';
import {scenePlanSchema,resourceIntentSchema} from '../packages/contracts/index.ts';
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {StoryRuntime} from '../packages/agent-runtime/runtime.ts';
import {deterministicProvider} from '../packages/agent-runtime/provider.ts';
import {storyDeterministicGenerator} from '../packages/agent-runtime/deterministic.ts';

const cleanups:Array<()=>Promise<void>>=[];
afterEach(async()=>{while(cleanups.length)await cleanups.pop()!();});

it('does not attribute an ambiguous same-name promise to either actor without structured evidence',async()=>{
  const value=await fixture();cleanups.push(value.close);const {storyId}=await value.store.create('test',testConfig(),17);const outline=await value.runtime.generateOutline(storyId,'test');
  const a=outline.characters[1],b=outline.characters[2];a.name='同名者';b.name='同名者';await value.store.saveOutline(storyId,'test',outline);await value.store.confirmOutline(storyId,'test');
  const factId=randomUUID(),text='同名者答应归还原件。',seq=(await value.database.pool.query('UPDATE stories SET fact_seq=fact_seq+1 WHERE id=$1 RETURNING fact_seq',[storyId])).rows[0].fact_seq;
  await value.database.pool.query("INSERT INTO facts(id,story_id,seq,time,kind,text,tags,visibility,source_turn_id,payload,created_at) VALUES($1,$2,$3,0,'dialogue',$4,$5,'public',$6,$7,$8)",[factId,storyId,seq,text,['promise'],randomUUID(),{type:'fact',change:{type:'fact',kind:'dialogue',text,tags:['promise']}},Date.now()]);
  await value.store.experience.indexFacts(value.database.pool,storyId,(await value.store.state(storyId)).characters);const row=(await value.database.pool.query('SELECT data FROM fact_memory WHERE fact_id=$1',[factId])).rows[0];expect(row.data.entityIds).not.toContain(a.id);expect(row.data.entityIds).not.toContain(b.id);
},60000);

it('keeps a key decision on full review with the optimization switch on or off',async()=>{
  const value=await fixture();cleanups.push(value.close);const base=deterministicProvider(storyDeterministicGenerator),runs:any[]=[];
  for(const fastReview of [false,true]){
    const {storyId}=await value.store.create('test',{...testConfig(),fastReview},19);await value.runtime.generateOutline(storyId,'test');await value.store.confirmOutline(storyId,'test');const context=await value.store.context(storyId),hero=context.characters[0];
    const plan=scenePlanSchema.parse({title:'关键选择',objective:'观察后选择调查路线',location:hero.location,participants:[hero.id],durationMinutes:5,beats:['讨论路线'],changes:[{type:'fact',kind:'dialogue',text:`${hero.name}听取了两条路线的说明，尚未决定。`,tags:['decision_point']}],requiresPlayerChoice:true,choicePrompt:'选择调查路线',choices:['核对北侧记录','核对南侧记录'],checkTags:[]});
    const runtime=new StoryRuntime(value.store,()=>({name:'deterministic',async run(role,prompt,schema,signal){if(role==='Director Agent')return schema.parse(plan);return base.run(role,prompt,schema,signal);}}));
    const turn=await value.store.enqueueTurn(storyId,'讨论调查路线','test','key-benchmark');await runtime.runTurn(turn.id);expect((await value.store.turn(turn.id)).status).toBe('waiting_player');const metrics=await value.store.metrics(storyId);expect(metrics.latency.phases.combined).toBeUndefined();expect(metrics.latency.phases.agency.samples).toBe(1);runs.push({fastReview,...metrics});
  }
  expect(runs[0].modelUsage.calls).toBe(runs[1].modelUsage.calls);await writeFile('reports/acceptance/critical-review-benchmark.json',JSON.stringify({provider:'deterministic',samplesPerMode:1,passed:true,runs},null,2));
},120000);

it('requires a new cost confirmation when an earlier choice authorized a different resource action',async()=>{
  const value=await fixture();cleanups.push(value.close);const {storyId}=await value.store.create('test',{...testConfig(),rulesAtStart:true},20);await value.runtime.generateOutline(storyId,'test');await value.store.confirmOutline(storyId,'test');
  const context=await value.store.context(storyId),hero=context.characters[0],intent=resourceIntentSchema.parse({actorId:hero.id,targetId:'local_obstacle',method:'treat',itemId:'medical_unique'});context.experience!.resources!.items.push({id:'medical_unique',name:'唯一药剂',ownerId:hero.id,consumed:false});
  context.confirmedDecision={id:randomUUID(),storyId,sceneId:randomUUID(),turnId:randomUUID(),stageId:context.stage!.id,prompt:'是否调查',options:[{id:'yes',text:'调查'},{id:'no',text:'暂缓'}],status:'resolved',choice:'调查',selectedOptionId:'yes',actionIntent:resourceIntentSchema.parse({actorId:hero.id,targetId:'local_obstacle',method:'investigate'}),continuationTurnId:null};
  const turn=await value.store.enqueueTurn(storyId,'处理眼前情况','test','cost-scope-check');const plan=scenePlanSchema.parse({title:'治疗',objective:'处理伤势',location:hero.location,participants:[hero.id],durationMinutes:30,beats:['治疗'],changes:[{type:'fact',kind:'action',text:'林序准备处理伤势。',tags:['treat']}],requiresPlayerChoice:false,choicePrompt:null,choices:[],checkTags:[],resourceIntent:intent});
  const result=await value.store.resources.prepare(turn.id,context,plan,intent);expect(result.requiresPlayerChoice).toBe(true);expect(result.choicePrompt).toContain("消耗物品：唯一药剂");expect((await value.database.pool.query('SELECT id FROM resource_attempts WHERE turn_id=$1',[turn.id])).rows).toHaveLength(0);
},60000);

it('manually resumes an imported precommit quote after earlier resource history without rerolling or duplicate charges',async()=>{
  const value=await fixture();cleanups.push(value.close);const {storyId}=await value.store.create('test',{...testConfig(),rulesAtStart:true},15);
  await value.runtime.generateOutline(storyId,'test');await value.store.confirmOutline(storyId,'test');
  const first=await value.store.enqueueTurn(storyId,'调查登记障碍','test','before-import-investigate',{resourceIntent:resourceIntentSchema.parse({actorId:'protagonist',targetId:'local_obstacle',method:'investigate'})});await value.runtime.runTurn(first.id);expect((await value.store.turn(first.id)).error).toBeNull();
  const context=await value.store.context(storyId),hero=context.characters.find(c=>c.id==='protagonist')!,intent=resourceIntentSchema.parse({actorId:hero.id,targetId:'local_obstacle',method:'sneak'});
  const turn=await value.store.enqueueTurn(storyId,'潜入登记障碍','test','pending-import-sneak',{resourceIntent:intent});await value.store.claim(turn.id);
  const plan=scenePlanSchema.parse({title:'潜入',objective:'尝试潜入',location:hero.location,participants:[hero.id],durationMinutes:20,beats:['尝试潜入'],changes:[{type:'fact',kind:'action',text:'林序经过登记入口。',tags:['sneak']}],failureChanges:[{type:'fact',kind:'action',text:'林序的潜入受阻，仍在入口之外。',tags:['sneak']}],requiresPlayerChoice:false,choicePrompt:null,choices:[],checkTags:[],resourceIntent:intent});
  const prepared=await value.store.resources.prepare(turn.id,context,plan,intent);await value.store.setTurnData(turn.id,'plan',prepared);await value.store.failTurn(turn.id,'模拟提交前服务停止');
  await value.store.experience.checkpoint(value.database.pool,storyId,'提交前手动恢复节点');
  const frozen=(await value.database.pool.query('SELECT data FROM resource_attempts WHERE turn_id=$1',[turn.id])).rows[0].data;
  const archive=new StoryArchive(value.store),restored=await archive.import('test',await archive.export(storyId),'import-frozen-attempt');
  const pending=(await value.database.pool.query("SELECT id FROM story_turns WHERE story_id=$1 AND import_suspended",[restored.storyId])).rows[0];expect(pending).toBeTruthy();
  await value.runtime.runTurn(pending.id);expect((await value.store.resources.panel(restored.storyId)).resources.attempts).toHaveLength(1);
  await value.store.retryTurn(restored.storyId,pending.id,'resume-frozen-attempt');await value.runtime.runTurn(pending.id);expect((await value.store.turn(pending.id)).error).toBeNull();
  const resources=(await value.store.resources.panel(restored.storyId)).resources;expect(resources.attempts).toHaveLength(2);expect(resources.attempts.at(-1)!.roll).toBe(frozen.resolved.attempt.roll);expect(resources.panels.protagonist.stamina).toBe(85);expect((await value.store.resources.panel(storyId)).resources.panels.protagonist.stamina).toBe(95);expect((await value.store.stateHashes(restored.storyId)).matches).toBe(true);
},120000);
