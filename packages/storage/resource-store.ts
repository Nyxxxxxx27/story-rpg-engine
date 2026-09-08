import {npcBoundary} from './npc-store.ts';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import type { StoryStore,RuntimeContext } from './store.ts';
import { scenePlanSchema, type ScenePlan, type Character, type StoryWorldConfig } from '../contracts/index.ts';
import { resourcePanelSchema, challengeSchema, resourceIntentSchema, type ResourceIntent, type ResourceState } from '../contracts/experience.ts';
import { actionQuote, initialResources, settleResource, resourceCostNotes } from '../content/resources.ts';
import { digest,parseStoredFact } from './experience-store.ts';
import { StoryConflict } from './errors.ts';

export const resourceSetupSchema=z.object({panels:z.record(z.string(),resourcePanelSchema),items:z.array(z.object({id:z.string().min(1).max(100),name:z.string().min(1).max(100),ownerId:z.string().min(1),consumed:z.boolean().default(false)}).strict()).max(100),challenges:z.array(challengeSchema).max(100),idempotencyKey:z.string().min(8).max(120)}).strict();
export class ResourceStore {
  constructor(readonly store:StoryStore){}
  async initialize(client:PoolClient,storyId:string,config:StoryWorldConfig,characters:Character[],panels:Record<string,z.infer<typeof resourcePanelSchema>>={}){
    if(!config.rulesAtStart)return;
    const state=await this.store.experience.state(storyId,client),resources=initialResources(config,characters);
    if(Object.keys(panels).some(id=>!characters.some(c=>c.id===id)))throw new StoryConflict('UNKNOWN_RESOURCE_ACTOR');
    Object.assign(resources.panels,panels);state.resources=resources;await this.store.experience.save(client,storyId,state,'初始角色资源');
  }
  async panel(storyId:string){const context=await this.store.context(storyId);return {resources:context.experience?.resources??initialResources(context.config,context.characters),enabled:!!context.experience?.resources?.enabled,characters:context.characters.map(c=>({id:c.id,name:c.name})),revision:context.experience?.revision??1};}
  async enable(storyId:string,input:z.infer<typeof resourceSetupSchema>){
    const body=resourceSetupSchema.parse(input),client=await this.store.database.pool.connect();
    try{await client.query('BEGIN');const story=(await client.query('SELECT * FROM stories WHERE id=$1 FOR UPDATE',[storyId])).rows[0];if(story.running_turn_id)throw new StoryConflict('STORY_BUSY');
      const prior=(await client.query('SELECT response FROM story_requests WHERE story_id=$1 AND key=$2',[storyId,body.idempotencyKey])).rows[0];if(prior){if(prior.response.hash!==digest(body))throw new StoryConflict('IDEMPOTENCY_CONFLICT');await client.query('COMMIT');return prior.response;}
      const state=await this.store.experience.state(storyId,client);if(state.resources?.enabled)throw new StoryConflict('RESOURCES_ALREADY_ENABLED');
      const characters=(await client.query('SELECT data FROM characters WHERE story_id=$1',[storyId])).rows.map(r=>r.data);
      const resources=initialResources(story.config,characters);
      if(characters.some(c=>!Object.hasOwn(body.panels,c.id))||Object.keys(body.panels).some(id=>!characters.some(c=>c.id===id))||body.items.some(i=>!characters.some(c=>c.id===i.ownerId))||new Set(body.items.map(i=>i.id)).size!==body.items.length||new Set(body.challenges.map(c=>c.id)).size!==body.challenges.length||body.challenges.some(c=>c.itemId&&!body.items.some(i=>i.id===c.itemId)||c.requiredItemId&&!body.items.some(i=>i.id===c.requiredItemId)||c.ownerId&&!characters.some(p=>p.id===c.ownerId)))throw new StoryConflict('INVALID_RESOURCE_SETUP');
      resources.panels=body.panels;resources.items=body.items;resources.challenges=body.challenges;state.resources=resources;
      await this.store.experience.save(client,storyId,state,'确认启用资源规则');await this.store.experience.checkpoint(client,storyId,'资源规则启用');
      const response={enabled:true,hash:digest(body)};await client.query('INSERT INTO story_requests(story_id,key,response) VALUES($1,$2,$3)',[storyId,body.idempotencyKey,response]);await client.query('COMMIT');return response;
    }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
  }
  async quote(storyId:string,intent:ResourceIntent){const context=await this.store.context(storyId);if(!context.experience?.resources)throw new StoryConflict('RESOURCES_NOT_ENABLED');const quote=actionQuote(context.experience.resources,intent,[...context.facts,...context.evidenceFacts,...context.relevantFacts??[]]);const available=Math.min(npcBoundary(context),context.stage?.deadlineMinutes==null?1440:context.stage.deadlineMinutes-context.clock);if(quote.minutes>available)throw new StoryConflict('ACTION_EXCEEDS_CRITICAL_BOUNDARY',`距离需要处理的时间节点只剩 ${available} 分钟，请先选择较短行动。`);return {...quote,costNotes:resourceCostNotes(context.experience.resources,intent)};}
  async prepare(turnId:string,context:RuntimeContext,plan:ScenePlan,explicit?:ResourceIntent|null){
    const resources=context.experience?.resources;
    const intent=explicit??plan.resourceIntent;
    if(!resources?.enabled)return plan;
    if(!intent){if(!plan.requiresPlayerChoice&&/潜入|强攻|破门|入侵|施展(?:术式|法术)|购买|支付|领取奖励/.test(JSON.stringify(plan.changes)))throw new StoryConflict('RESOURCE_INTENT_REQUIRED');return plan;}
    resourceIntentSchema.parse(intent);
    const protagonist=context.characters.find(c=>c.importance==='protagonist')!;
    if(intent.actorId!==protagonist.id)throw new StoryConflict('PLAYER_ACTION_ACTOR_MISMATCH');
    if(plan.requiresPlayerChoice)return scenePlanSchema.parse({...plan,resourceIntent:intent});
    const row=(await this.store.database.pool.query('SELECT seed FROM stories WHERE id=(SELECT story_id FROM story_turns WHERE id=$1)',[turnId])).rows[0];
    const facts=[...context.facts,...context.evidenceFacts,...context.relevantFacts??[]];
    const quote=actionQuote(resources,intent,facts);
    const decision=context.confirmedDecision;
    const confirmedCost=decision?.actionIntent&&digest(decision.actionIntent)===digest(intent)&&(decision.selectedOptionId===null||decision.selectedOptionId===decision.options[0]?.id);
    if(quote.requiresConfirmation&&!confirmedCost)return scenePlanSchema.parse({...plan,resourceIntent:intent,requiresPlayerChoice:true,choicePrompt:`${quote.label}需要体力${quote.cost}、金钱${quote.money}、${quote.minutes}分钟。${resourceCostNotes(resources,intent).join("；")}是否执行？`,choices:[`执行${quote.label}，接受上述代价`,'暂缓此行动'],durationMinutes:1,changes:[{type:'fact',kind:'dialogue',text:`${protagonist.name}听取了行动需要付出的代价，尚未行动。`,tags:['decision_point']}],failureChanges:[]});
    if(plan.durationMinutes!==quote.minutes)throw new StoryConflict('RESOURCE_DURATION_MISMATCH',`此动作必须规划为 ${quote.minutes} 故事分钟，不能附带其他行动填充时长。`);
    const frozen=(await this.store.database.pool.query('SELECT data FROM resource_attempts WHERE turn_id=$1',[turnId])).rows[0]?.data;
    const resolved=frozen?.resolved??settleResource(resources,intent,Number(row.seed),turnId,facts);
    if(frozen&&digest(frozen.intent)!==digest(intent))throw new StoryConflict('FROZEN_ACTION_CHANGED');
    if(quote.fingerprint!==resolved.quote.fingerprint)throw new StoryConflict('ACTION_QUOTE_STALE');
    const resultText=`${protagonist.name}的${resolved.attempt.result}`;
    const resultChange={type:'fact' as const,kind:'action' as const,text:resultText,tags:['resource_result',protagonist.id,resolved.attempt.key]};
    const selected=resolved.quote.dc===null?[]:resolved.attempt.success?plan.changes:plan.failureChanges;
    if(selected.length>14)throw new StoryConflict('RESOURCE_TOO_MANY_EFFECTS');
    const relations=!resolved.attempt.success&&intent.method==='negotiate'&&plan.participants.find(id=>id!==intent.actorId)?[{type:'relationship' as const,from:intent.actorId,to:plan.participants.find(id=>id!==intent.actorId)!,dimension:'trust' as const,delta:-1,reason:'本次交涉条件被拒绝，互信受损。',significance:'minor' as const}]:[];
    const conditions=resources.panels[intent.actorId].injury!==resolved.state.panels[intent.actorId].injury?[{type:'character' as const,characterId:intent.actorId,field:'condition' as const,value:['无伤','轻伤','重伤','失能'][resolved.state.panels[intent.actorId].injury],significance:'minor' as const}]:[];
    const effective=scenePlanSchema.parse({...plan,resourceIntent:intent,checkTags:[...new Set([...plan.checkTags,...(resolved.quote.dc!==null?['skill_check']:[])])],...(resolved.quote.dc===null?{location:protagonist.location,participants:[protagonist.id],memoryAnnotations:[],knowledgeUpdates:[],observations:[],npcUses:[]} :{}),...(!resolved.attempt.success?{memoryAnnotations:[],knowledgeUpdates:[],observations:[],npcUses:[],choices:['更换行动方式','寻找新的行动条件']}:{}),changes:[...selected.filter(c=>!(c.type==='fact'&&c.tags.includes('resource_result'))),...conditions,...relations,resultChange]});
    await this.store.database.pool.query('INSERT INTO resource_attempts(id,story_id,turn_id,data) SELECT $1,story_id,id,$3 FROM story_turns WHERE id=$2 ON CONFLICT(turn_id) DO NOTHING',[randomUUID(),turnId,{intent,resolved,before:digest(resources),resultText}]);
    return effective;
  }
  async commit(client:PoolClient,storyId:string,turnId:string,plan:ScenePlan){
    if(!plan.resourceIntent||plan.requiresPlayerChoice)return;
    const row=(await client.query('SELECT data FROM resource_attempts WHERE story_id=$1 AND turn_id=$2',[storyId,turnId])).rows[0];if(!row)throw new StoryConflict('RESOURCE_ACTION_NOT_PREPARED');
    const state=await this.store.experience.state(storyId,client);
    if(digest(state.resources)!==row.data.before)throw new StoryConflict('ACTION_QUOTE_STALE');
    if(digest(plan.resourceIntent)!==digest(row.data.intent)||!plan.changes.some(c=>c.type==='fact'&&c.text===row.data.resultText&&c.tags.includes('resource_result'))||plan.durationMinutes!==row.data.resolved.quote.minutes)throw new StoryConflict('RESOURCE_RESULT_CHANGED');
    state.resources=row.data.resolved.state;await this.store.experience.save(client,storyId,state,'行动资源已结算',turnId);
  }
}
