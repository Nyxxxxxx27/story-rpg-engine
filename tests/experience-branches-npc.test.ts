import {afterEach,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {fixture,testConfig,createActiveStory} from './helpers.ts';
import {StoryRuntime} from '../packages/agent-runtime/runtime.ts';
import {deterministicProvider} from '../packages/agent-runtime/provider.ts';
import {storyDeterministicGenerator} from '../packages/agent-runtime/deterministic.ts';
import {scenePlanSchema,stageReviewSchema,npcGoalSchema,narrationSchema} from '../packages/contracts/index.ts';
import {eligibleRoutes,validateGraph} from '../packages/storage/branches.ts';
import {layeredPrompt} from '../packages/agent-runtime/prompts.ts';
import {npcBatchSchema} from '../packages/storage/npc-store.ts';
import {StoryArchive} from '../packages/storage/archive.ts';
const cleanups:Array<()=>Promise<void>>=[];afterEach(async()=>{while(cleanups.length)await cleanups.pop()!();});
it('opens escort, pursuit or remedy from confirmed facts and requires route confirmation',async()=>{
  const value=await fixture();cleanups.push(value.close);
  for(const route of ['escort','pursuit','remedy']){
    const {storyId:id}=await value.store.create('test',testConfig('modern_mystery'),11);await value.runtime.generateOutline(id,'test');await value.store.confirmOutline(id,'test');
    const advance=async(text:string,assertions:any[]=[],complete=true)=>{const context=await value.store.context(id),hero=context.characters[0];const turn=await value.store.enqueueTurn(id,text,'test',randomUUID());await value.store.claim(turn.id);
      const plan=scenePlanSchema.parse({title:'核验结果',objective:'核验本次行动结果',location:hero.location,participants:[hero.id],durationMinutes:1,beats:['查看已发生的结果'],changes:[{type:'fact',kind:'action',text,tags:['result']}],requiresPlayerChoice:false,choicePrompt:null,choices:[],checkTags:[]});
      await value.store.setTurnData(turn.id,'plan',plan);const assessment=stageReviewSchema.parse({approved:true,summary:'核验结果',issues:[],assertions:assertions.map(([key,value])=>({key,value,evidence:[{type:'change',index:0}],reason:text})),milestones:complete?context.stage!.milestones.map(m=>({milestoneId:m.id,evidence:[{type:'change',index:0}],reason:text})):[]});
      await value.store.commitScene(turn.id,plan,{stage:assessment});await value.runtime.runTurn(turn.id);return turn.id;};
    await advance('已找到证人被拘留的位置，核实了本阶段行动的实际结果。');let proposals=await value.store.pendingProposals(id);expect(proposals).toHaveLength(1);await value.store.reviewProposal(id,proposals[0].id,'accept');
    if(route!=='escort'){const state=await value.store.state(id);await value.store.editStage(id,{...state.activeStage!,deadlineMinutes:state.clock+1});}
    await advance(route==='escort'?'证人已获救并处于安全状态，本阶段行动的实际结果已经核实。':route==='pursuit'?'本次营救失败，现场取得了可追踪幕后主使的车辙线索。':'现场信息不足，尚未确认营救结果。',route==='escort'?[['witness_rescued',true]]:route==='pursuit'?[['rescue_failed',true],['tracking_clue',true]]:[],route==='escort');
    if(route!=='escort'){const state=await value.store.state(id);expect(state.activeStage!.awaitingDeadline).toBe(true);await value.store.resolveDeadline(id,state.activeStage!.id,{action:'close',revision:state.activeStage!.revision,idempotencyKey:randomUUID()});}
    proposals=await value.store.pendingProposals(id);expect(proposals.map(p=>p.stage.nodeId)).toEqual([route]);expect((await value.store.state(id)).activeStage?.nodeId).toBe('rescue');
    await value.store.reviewProposal(id,proposals[0].id,'accept');expect((await value.store.state(id)).activeStage?.nodeId).toBe(route);
    await advance(`已完成${route}路线的实际任务，并核实其后果。`);proposals=await value.store.pendingProposals(id);await value.store.reviewProposal(id,proposals[0].id,'accept');await advance('本路线的证据已经归档，实际结局已经核实。');expect((await value.store.state(id)).status).toBe('finished');expect((await value.store.stateHashes(id)).matches).toBe(true);
  }
},120000);
it('isolates NPC secrets, records witnessed knowledge, and enforces an actionable warning window',async()=>{
  const value=await fixture();cleanups.push(value.close);const id=await createActiveStory(value);const context=await value.store.context(id);const hero=context.characters[0],actor=context.characters[1];const base=deterministicProvider(storyDeterministicGenerator);let calls=0,registered=false;
  const runtime=new StoryRuntime(value.store,()=>({name:'deterministic',async run(role,prompt,schema,signal){
    if(role==='Director Agent')return schema.parse({title:'守候消息',objective:'观察当前情况',location:hero.location,participants:[hero.id,actor.id],durationMinutes:prompt.includes('"maxDurationMinutes":60')?60:10,beats:['听取消息'],changes:[{type:'fact',kind:'dialogue',text:`${actor.name}告知${hero.name}：有人准备带走重要原件。`,tags:['npc_promise',actor.id]}],observations:[{changeIndex:0,witnessIds:[hero.id,actor.id],recipientIds:[hero.id],speakerId:actor.id}],requiresPlayerChoice:false,choicePrompt:null,choices:['继续观察'],checkTags:[]});
    if(role==='Stage Agent'){const goals=registered?[]:[{id:'warning_goal',actorId:actor.id,kind:'faction',title:'带走重要原件',dueMinutes:0,triggerFactIds:[],evidence:[{type:'change',index:0}],irreversible:true,action:null,triggerStageId:null,cancel:false}];registered=true;return schema.parse({approved:true,summary:'核验承诺',issues:[],milestones:[],npcGoals:goals});}
    if(role==='NPC Scheduler'){calls++;const current=await value.store.experience.state(id);const goal=current.goals[0];return schema.parse({actions:[{goalId:goal.id,text:'重要原件即将被带走。',usedFactIds:[],changes:goal.status==='pending'?[]:[{type:'character',characterId:actor.id,field:'condition',value:'带着原件永久离场',significance:'major'}]}]});}
    return base.run(role,prompt,schema,signal);
  }}));
  const run=async()=>{const turn=await value.store.enqueueTurn(id,'观察现场','test',randomUUID());await runtime.runTurn(turn.id);const result=await value.store.turn(turn.id);expect(result.error).toBeNull();expect(result.status).toBe('completed');return result;};
  await run();expect(calls).toBe(0);await run();expect(calls).toBe(1);let state=await value.store.experience.state(id);expect(state.goals[0].status).toBe('warned');expect((await value.store.state(id)).characters.find(c=>c.id===actor.id)?.condition).not.toContain('永久');
  const warning=state.goals[0];await run();expect(calls).toBe(1);expect((await value.store.state(id)).clock).toBe(warning.warningClock!+60);await run();expect(calls).toBe(2);state=await value.store.experience.state(id);expect(state.goals[0].status).toBe('completed');expect((await value.store.state(id)).characters.find(c=>c.id===actor.id)?.condition).toContain('永久');
  const known=state.knowledge.find(k=>k.characterId===actor.id)!;expect(known.mode).toBe('reported');
  const isolated=layeredPrompt('Character Agent',{...await value.store.context(id),characterId:actor.id},'审查可知行动',narrationSchema);expect(isolated).not.toContain(context.characters.find(c=>c.id!==actor.id&&c.id!==hero.id)!.privateProfile);expect(isolated).not.toContain('<world_assertions>');
  const stranger=context.characters.find(c=>c.id!==actor.id&&c.id!==hero.id)!;const forbidden=scenePlanSchema.parse({title:'秘密',objective:'闲聊',location:hero.location,participants:[hero.id],durationMinutes:1,beats:['闲聊'],changes:[{type:'fact',kind:'dialogue',text:'闲谈天气。',tags:['chat']}],npcUses:[{characterId:stranger.id,factId:known.factId,changeIndex:0}],requiresPlayerChoice:false,choicePrompt:null,choices:[],checkTags:[]});
  const turn=await value.store.enqueueTurn(id,'错误知识测试','test',randomUUID());await value.store.claim(turn.id);await expect(value.store.commitScene(turn.id,forbidden)).rejects.toThrow('NPC_UNKNOWN_KNOWLEDGE');await value.store.failTurn(turn.id,'测试中拒绝未知秘密');
  expect((await value.store.stateHashes(id)).matches).toBe(true);const archives=new StoryArchive(value.store);const imported=await archives.import('test',await archives.export(id),'npc-import-001');expect((await value.store.experience.state(imported.storyId)).goals[0].status).toBe('completed');
},120000);
