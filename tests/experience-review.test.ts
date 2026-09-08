import {afterEach,expect,it} from 'vitest';
import {mkdir,writeFile} from 'node:fs/promises';
import {fixture,testConfig} from './helpers.ts';
import {StoryRuntime} from '../packages/agent-runtime/runtime.ts';
import {deterministicProvider} from '../packages/agent-runtime/provider.ts';
import {storyDeterministicGenerator} from '../packages/agent-runtime/deterministic.ts';
import {lowRiskPlan} from '../packages/agent-runtime/observability.ts';
import {scenePlanSchema} from '../packages/contracts/index.ts';
const cleanups:Array<()=>Promise<void>>=[];afterEach(async()=>{while(cleanups.length)await cleanups.pop()!();});
it('reduces ordinary review calls while retaining full review for key actions and identical public outcomes',async()=>{
  const value=await fixture();cleanups.push(value.close);const base=deterministicProvider(storyDeterministicGenerator);const report:any={provider:'deterministic',samplesPerMode:12,note:'耗时来自隔离本地负载；不代表真实模型延迟。tokens 未返回时保持未知。',runs:[]};const outputs:string[][]=[];
  for(const fastReview of [false,true]){
    const {storyId}=await value.store.create('test',{...testConfig(),fastReview},3);await value.runtime.generateOutline(storyId,'test');await value.store.confirmOutline(storyId,'test');
    const context=await value.store.context(storyId),hero=context.characters[0];const plan=scenePlanSchema.parse({title:'问候',objective:'观察与闲聊',location:hero.location,participants:[hero.id],durationMinutes:5,beats:['问候'],changes:[{type:'fact',kind:'dialogue',text:`${hero.name}向值守者问候，谈起天气。`,tags:['chat']}],requiresPlayerChoice:false,choicePrompt:null,choices:['继续观察'],checkTags:[]});
    expect(lowRiskPlan(context,{...plan,checkTags:['death']})).toBe(false);expect(lowRiskPlan(context,{...plan,requiresPlayerChoice:true})).toBe(false);
    const runtime=new StoryRuntime(value.store,()=>({name:'deterministic',async run(role,prompt,schema,signal){if(role==='Director Agent')return schema.parse(plan);return base.run(role,prompt,schema,signal);}}));
    const prose:string[]=[];for(let i=0;i<12;i++){const turn=await value.store.enqueueTurn(storyId,'观察与闲聊','test',`benchmark-${i}`);await runtime.runTurn(turn.id);const result=await value.store.turn(turn.id);expect(result.error).toBeNull();expect(result.scene?.validation?.mode).toBe('rules');prose.push(result.scene!.prose);}
    outputs.push(prose);const metrics=await value.store.metrics(storyId);report.runs.push({fastReview,...metrics});expect(metrics.latency.firstPublication.samples).toBe(12);expect(metrics.modelUsage.inputTokens).toBeNull();expect((await value.store.stateHashes(storyId)).matches).toBe(true);
  }
  expect(outputs[0]).toEqual(outputs[1]);expect(report.runs[1].modelUsage.calls).toBeLessThan(report.runs[0].modelUsage.calls);expect(report.runs[1].latency.phases.combined.samples).toBe(12);report.passed=true;
  await mkdir('reports/acceptance',{recursive:true});await writeFile('reports/acceptance/review-benchmark.json',JSON.stringify(report,null,2));
},120000);
