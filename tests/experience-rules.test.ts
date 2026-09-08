import {expect,it,afterEach} from 'vitest';
import {randomUUID} from 'node:crypto';
import {initialResources,actionQuote,settleResource,fixedRoll} from '../packages/content/resources.ts';
import {characterSchema,resourceIntentSchema,challengeSchema,factSchema} from '../packages/contracts/index.ts';
import {fixture,testConfig} from './helpers.ts';
import {StoryArchive} from '../packages/storage/archive.ts';
const cast=[characterSchema.parse({id:'protagonist',name:'林序',importance:'protagonist',publicProfile:'调查者',location:'基地'})];
const intent=(method:string)=>resourceIntentSchema.parse({actorId:'protagonist',targetId:'local_obstacle',method});
const cleanups:Array<()=>Promise<void>>=[];afterEach(async()=>{while(cleanups.length)await cleanups.pop()!();});
it('quotes distinct strategies, charges failed attempts once and fixes fork randomness',()=>{
  const state=initialResources(testConfig(),cast);
  expect(['sneak','negotiate','force'].map(m=>{const q=actionQuote(state,intent(m));return[q.cost,q.minutes,q.dc];})).toEqual([[10,20,14],[5,15,14],[20,10,14]]);
  const action=intent('force'),quote=actionQuote(state,action);let seed=1;while(fixedRoll(seed,quote.fingerprint)+quote.modifier>=quote.dc!)seed++;
  const turnId=randomUUID(),first=settleResource(state,action,seed,turnId),same=settleResource(first.state,action,seed,turnId),fork=settleResource(state,action,seed,randomUUID());
  expect(first.attempt.success).toBe(false);expect(first.state.panels.protagonist.stamina).toBe(80);expect(first.state.panels.protagonist.injury).toBe(1);expect(same.state).toEqual(first.state);expect(fork.attempt.roll).toBe(first.attempt.roll);
  const sneaking=settleResource(state,intent('sneak'),1,randomUUID());expect(()=>settleResource(sneaking.state,intent('sneak'),1,randomUUID())).toThrow('ACTION_ALREADY_RESOLVED');
  const poor=structuredClone(state);poor.panels.protagonist.stamina=4;expect(()=>settleResource(poor,intent('investigate'),1,randomUUID())).toThrow('INSUFFICIENT_STAMINA');expect(poor.attempts).toEqual([]);
  expect(()=>actionQuote(state,{...intent('sneak'),itemId:'fake_reroll'})).toThrow('UNUSED_ITEM_ARGUMENT');
});
it('implements restoration and genre pools without charging historical prose',()=>{
  for(const genre of ['cultivation','western_fantasy','science_fiction','modern_mystery'] as const){const state=initialResources(testConfig(genre),cast);state.panels.protagonist.stamina=10;const rested=settleResource(state,intent('rest'),1,randomUUID());expect(rested.state.panels.protagonist.stamina).toBe(40);expect(rested.quote.minutes).toBe(30);expect(settleResource(state,intent('long_rest'),1,randomUUID()).state.panels.protagonist.stamina).toBe(100);}
  const cultivation=initialResources(testConfig('cultivation'),cast);expect(settleResource(cultivation,intent('technique'),1,randomUUID()).state.panels.protagonist.energy).toBe(25);
  const fantasy=initialResources(testConfig('western_fantasy'),cast);const shield=settleResource(fantasy,intent('shield'),1,randomUUID());expect(shield.state.panels.protagonist).toMatchObject({shield:true,spellSlots:2});
  const science=initialResources(testConfig(),cast);expect(()=>actionQuote(science,intent('hack'))).toThrow('HACK_TOOL');expect(settleResource(science,{...intent('hack'),itemId:'toolkit'},1,randomUUID()).state.panels.protagonist.energy).toBe(20);
});
it('checks item owners, evidence-backed rewards and unique settlement sources',()=>{
  const seller=characterSchema.parse({id:'seller',name:'商人',importance:'supporting',publicProfile:'持有原件',location:'基地'});const state=initialResources(testConfig(),[...cast,seller]);
  state.items.push({id:'original',name:'原始记录',ownerId:'seller',consumed:false});state.challenges.push(challengeSchema.parse({id:'original_offer',title:'原始记录报价',methods:['trade'],itemId:'original',ownerId:'seller',price:20}));
  const trade=resourceIntentSchema.parse({actorId:'protagonist',targetId:'original_offer',method:'trade'}),turnId=randomUUID(),paid=settleResource(state,trade,1,turnId);expect(paid.state.items.find(i=>i.id==='original')?.ownerId).toBe('protagonist');expect(paid.state.panels.protagonist.money).toBe(80);expect(paid.state.panels.seller.money).toBe(120);expect(settleResource(paid.state,trade,1,turnId).state).toEqual(paid.state);expect(()=>settleResource(paid.state,trade,1,randomUUID())).toThrow('TRADE_PRECONDITION');
  const fact=factSchema.parse({id:randomUUID(),seq:1,time:1,kind:'action',text:'已按登记要求完成交付。',tags:['delivery'],visibility:'public',sourceTurnId:randomUUID(),payload:{type:'fact'}});state.challenges.push(challengeSchema.parse({id:'delivery_reward',title:'交付报酬',methods:['reward'],state:'passed',rewardMoney:30,evidenceFactIds:[fact.id]}));const reward=resourceIntentSchema.parse({actorId:'protagonist',targetId:'delivery_reward',method:'reward'});expect(()=>settleResource(state,reward,1,randomUUID())).toThrow('REWARD_EVIDENCE');const rewarded=settleResource(state,reward,1,randomUUID(),[fact]);expect(rewarded.state.panels.protagonist.money).toBe(130);expect(()=>settleResource(rewarded.state,reward,1,randomUUID(),[fact])).toThrow('REWARD_EVIDENCE');
});
it('uses one frozen engine result across concurrent enqueue, narration retry and independent fork',async()=>{
  const value=await fixture();cleanups.push(value.close);const created=await value.store.create('test',{...testConfig(),rulesAtStart:true},15),id=created.storyId;
  await value.runtime.generateOutline(id,'test');await value.store.confirmOutline(id,'test');const before=(await value.store.experience.checkpoints(id))[0];const archive=new StoryArchive(value.store);const child=await archive.fork('test',id,before.id,'rules-fork-001');
  const run=async(storyId:string)=>{const [a,b]=await Promise.all([value.store.enqueueTurn(storyId,'调查登记障碍','test','rules-action-001',{resourceIntent:intent('investigate')}),value.store.enqueueTurn(storyId,'调查登记障碍','test','rules-action-001',{resourceIntent:intent('investigate')})]);expect(a.id).toBe(b.id);await value.runtime.runTurn(a.id);expect((await value.store.turn(a.id)).error).toBeNull();return value.store.turn(a.id);};
  const turn=await run(id),fork=await run(child.storyId);expect(turn.scene?.endTime).toBe(15);
  const original=await value.store.resources.panel(id),branched=await value.store.resources.panel(child.storyId);expect(original.resources.attempts).toHaveLength(1);expect(original.resources.attempts[0].roll).toBe(branched.resources.attempts[0].roll);expect(original.resources.panels.protagonist.stamina).toBe(95);
  await value.store.retrySceneNarration(id,turn.scene!.id,'rules-narration-001');await value.runtime.runTurn(turn.id);expect((await value.store.resources.panel(id)).resources).toEqual(original.resources);
  const restored=await archive.import('test',await archive.export(id),'rules-import-001');expect((await value.store.resources.panel(restored.storyId)).resources.panels).toEqual(original.resources.panels);expect((await value.store.stateHashes(restored.storyId)).matches).toBe(true);
},120000);
