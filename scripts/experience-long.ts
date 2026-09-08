import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {connectDatabase} from '../packages/storage/database.ts';
import {StoryStore} from '../packages/storage/store.ts';
import {StoryRuntime} from '../packages/agent-runtime/runtime.ts';
import {deterministicProvider} from '../packages/agent-runtime/provider.ts';
import {storyDeterministicGenerator} from '../packages/agent-runtime/deterministic.ts';
import {StoryArchive} from '../packages/storage/archive.ts';
import {scenePlanSchema,resourceIntentSchema} from '../packages/contracts/index.ts';
import {layeredPrompt} from '../packages/agent-runtime/prompts.ts';
const directory=resolve(`.data/experience-long-${randomUUID()}`),database=await connectDatabase({directory});const store=new StoryStore(database);await store.setup();const base=deterministicProvider(storyDeterministicGenerator);
const report:any={startedAt:new Date().toISOString(),directory,passed:false,scenes:0,checkpoints:[],turns:[]};let number=0,id='',ordinary=0,combined=0,npcCalls=0;
const runtime=new StoryRuntime(store,()=>({name:'deterministic',async run(role,prompt,schema,signal){
  if(role==='Director Agent'){
    if(/明确的结构化行动：[^。]+"method":"rest"/.test(prompt))return base.run(role,prompt,schema,signal);
    const context=await store.context(id),hero=context.characters[0];const choosing=number>0&&number%37===0&&!context.confirmedDecision;
    const text=number===0?'林序答应程弥：原件只交还本人，绝不交给竞争者。':`林序与程弥谈起天气，第${number+1}次交谈仍然平静。`;
    return schema.parse({title:'值守记录',objective:'观察与闲聊',location:hero.location,participants:[hero.id,'core-heroine'],durationMinutes:choosing?1:30,beats:['交谈'],changes:[{type:'fact',kind:'dialogue',text,tags:['chat']}],requiresPlayerChoice:choosing,choicePrompt:choosing?'下一步先看哪一份公开记录？':null,choices:['留在原处核对记录','先与同伴谈谈'],checkTags:[]});
  }
  if(role==='Stage Agent')return schema.parse({approved:true,summary:'不以值守替代主线目标',issues:[],milestones:[],npcGoals:number===0?[{id:'npc-checkin',actorId:'core-heroine',kind:'promise',title:'回访并说明公开记录状况',dueMinutes:120,evidence:[{type:'change',index:0}],irreversible:false,action:null}]:[]});
  if(role==='Combined Review Agent')combined++;if(role==='Continuity Agent')ordinary++;if(role==='NPC Scheduler')npcCalls++;
  return base.run(role,prompt,schema,signal);
}}));
try{
  const config={title:'两百场值守验收',genre:'science_fiction' as const,premise:'林序与程弥在中继站值守，守住旧日承诺。',tone:'克制',pacing:'balanced' as const,worldRules:[],terminology:{},contentBoundaries:[],storyPacks:['generic-story'],advancedPrompt:'',provider:'deterministic' as const,polishMode:'standard' as const,romanceMode:'off' as const,fastReview:true,rulesAtStart:true};
  id=(await store.create('acceptance',config,20260906)).storyId;report.storyId=id;await runtime.generateOutline(id,'acceptance');await store.confirmOutline(id,'acceptance');
  while(number<200){
    const current=await store.state(id);let turnId:string;
    if(current.pendingDecision)turnId=(await store.resolveChoice(id,{decisionId:current.pendingDecision.id,optionId:current.pendingDecision.options[0].id,source:'test',idempotencyKey:`long-choice-${number}`})).continuationTurnId;
    else turnId=(await store.enqueueTurn(id,number===0?'我向程弥作出保管承诺。':'在原处观察或休息。','test',`long-${number}`,number>0&&number%10===0?{resourceIntent:resourceIntentSchema.parse({actorId:'protagonist',targetId:'local_obstacle',method:'rest'})}:undefined)).id;
    const start=Date.now();await runtime.runTurn(turnId);const result=await store.turn(turnId);assert.equal(result.error,null);assert.ok(result.scene?.published);assert.ok(result.scene?.claims.length);report.turns.push({turnId,ms:Date.now()-start,mode:result.scene?.validation?.mode});number++;report.scenes=number;
    if(number%25===0){assert.ok((await store.stateHashes(id)).matches);console.log(`[experience-long] ${number}/200 clock=${(await store.state(id)).clock}`);}
    if(number===75||number===150){const archive=new StoryArchive(store);const save=await archive.export(id),restored=await archive.import('acceptance',save,`long-import-${number}`);assert.ok((await store.stateHashes(restored.storyId)).matches);report.checkpoints.push(restored);}
  }
  const context=await store.context(id,'程弥回来领取原件，我应该如何处理？');assert.ok(context.relevantFacts?.some(f=>f.text.includes('绝不交给竞争者')));assert.ok(layeredPrompt('Director Agent',context,'履行旧承诺',scenePlanSchema).includes('绝不交给竞争者'));
  const all:number[]=[];let cursor:string|undefined;do{const page=await store.experience.history(id,cursor);all.push(...page.items.map(s=>s.seq));cursor=page.nextCursor??undefined;}while(cursor);assert.equal(all.length,200);assert.equal(new Set(all).size,200);
  report.retrieval=context.memoryHits;report.metrics=await store.metrics(id);report.npcCalls=npcCalls;report.fullReviews=ordinary;report.combinedReviews=combined;report.hashes=await store.stateHashes(id);report.clock=(await store.state(id)).clock;report.passed=true;
}catch(e){report.error=e instanceof Error?e.message:String(e);console.error('[experience-long]',report.error);process.exitCode=1;}
finally{report.completedAt=new Date().toISOString();await mkdir(resolve('reports/acceptance'),{recursive:true});await writeFile(resolve('reports/acceptance/experience-long.json'),JSON.stringify(report,null,2));await database.close();}
