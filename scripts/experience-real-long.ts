import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {connectDatabase} from '../packages/storage/database.ts';
import {StoryStore} from '../packages/storage/store.ts';
import {StoryRuntime} from '../packages/agent-runtime/runtime.ts';
import {codexProvider,deterministicProvider} from '../packages/agent-runtime/provider.ts';
import {storyDeterministicGenerator} from '../packages/agent-runtime/deterministic.ts';
import {resourceIntentSchema} from '../packages/contracts/index.ts';
import {StoryArchive} from '../packages/storage/archive.ts';
const previous=process.argv.includes('--resume')?JSON.parse(await readFile(resolve('reports/acceptance/experience-real-long.json'),'utf8')):null;
const directory=previous?.directory??resolve(`.data/experience-real-${randomUUID()}`),database=await connectDatabase({directory});const store=new StoryStore(database);await store.setup();const real=codexProvider();const runtime=new StoryRuntime(store,()=>real);
const report:any={startedAt:new Date().toISOString(),directory,provider:'codex',passed:false,coverage:'固定大纲，真实规划/审查/正文；资源行动与长休跨三个故事日。自然分支与NPC触发另由确定性集成测试覆盖。',turns:[],...previous,restarts:[...previous?.restarts??[],new Date().toISOString()]};
try{
  const config={title:'三日档案守护',genre:'science_fiction' as const,premise:'林序在中继站守护档案，同行者程弥将于三日后领取封存的原件。在此之前可以观察、交谈、调查登记障碍和休息。原件仍须留存，不能提前移交。',tone:'简明克制',pacing:'balanced' as const,worldRules:['所有技能成败由登记规则结算'],terminology:{},contentBoundaries:[],storyPacks:['generic-story'],advancedPrompt:'资源行动的时间必须精确采用已报价时间。休息不创造调查结果。调查失败不会让隐藏目标自动达成。npcEffects由调度器填写，Director保持空数组。',provider:'codex' as const,polishMode:'standard' as const,romanceMode:'organic' as const,fastReview:true,rulesAtStart:true};
  const {storyId}=previous?{storyId:previous.storyId}:await store.create('acceptance',config,20260907);report.storyId=storyId;const setup=new StoryRuntime(store,()=>deterministicProvider(storyDeterministicGenerator));if(!previous){const outline=await setup.generateOutline(storyId,'acceptance');
  outline.stages[0].objective='等待三日后的约定交接，并保留尚未验证的事项';outline.stages[0].completionCriteria=['三日后取得程弥签署的正式交接回执','原始档案在正式交接时已完成逐项清点'];outline.stages[0].deadlineMinutes=10080;outline.stages[0].entryCriteria=[];await store.confirmOutline(storyId,'acceptance',outline);}
  const methods=['investigate','sneak','negotiate',...Array.from({length:9},()=> 'long_rest')];
  for(const [index,method] of methods.entries()){
    if(previous?.turns.filter((t:any)=>t.status==='completed').length>index)continue;
    let state=await store.state(storyId);assert.equal(state.status,'active');assert.equal(state.pendingDecision,null);
    const action=resourceIntentSchema.parse({actorId:'protagonist',targetId:'local_obstacle',method});const input=method==='long_rest'?'我在当前安全的中继站长休八小时，期间不进行调查、不移动地点，也不作重大决定。':`我使用${({investigate:'调查',sneak:'潜入',negotiate:'交涉'} as any)[method]}方式应对登记障碍，接受规则给出的普通尝试成本，成功与失败都只执行已报价的这一个行动。`;
    const turn=await store.enqueueTurn(storyId,input,'test',`real-long-${index}`,{resourceIntent:action});if(turn.status==='failed')await store.retryTurn(storyId,turn.id,`resume-${index}-${report.restarts.length}`);console.log(`[experience-real] ${index+1}/${methods.length} ${method} clock=${state.clock}`);const start=Date.now();await runtime.runTurn(turn.id);const result=await store.turn(turn.id);report.turns.push({id:result.id,method,status:result.status,error:result.error,elapsedMs:Date.now()-start,validation:result.scene?.validation});
    assert.equal(result.error,null);assert.ok(result.scene?.published);assert.equal(result.status,'completed');assert.ok((await store.stateHashes(storyId)).matches);
    if(index===5){const archives=new StoryArchive(store);const exported=await archives.export(storyId);const restored=await archives.import('acceptance',exported,'real-long-import');assert.ok((await store.stateHashes(restored.storyId)).matches);report.restore={...restored,historicalDispatches:(await database.pool.query('SELECT count(*)::int AS n FROM story_outbox WHERE dispatched=false AND turn_id IN (SELECT id FROM story_turns WHERE story_id=$1)',[restored.storyId])).rows[0].n};}
  }
  const state=await store.state(storyId);assert.ok(state.clock>=4320);report.clock=state.clock;report.metrics=await store.metrics(storyId);report.hashes=await store.stateHashes(storyId);if(report.error)report.resolvedErrors=[...report.resolvedErrors??[],report.error];report.error=null;report.passed=true;
}catch(e){report.error=e instanceof Error?e.message:String(e);process.exitCode=1;console.error('[experience-real]',report.error);}
finally{report.completedAt=new Date().toISOString();await mkdir(resolve('reports/acceptance'),{recursive:true});await writeFile(resolve('reports/acceptance/experience-real-long.json'),JSON.stringify(report,null,2));await real.close?.();await database.close();}
