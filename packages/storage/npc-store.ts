import { majorPattern } from './stages.ts';
import { z } from 'zod';
import type { PoolClient } from 'pg';
import { scenePlanSchema, stateChangeSchema, type ScenePlan, type CanonicalFact, type StageReview } from '../contracts/index.ts';
import { npcGoalSchema, type NpcGoal, type ExperienceState } from '../contracts/experience.ts';
import type { StoryStore, RuntimeContext } from './store.ts';
import { digest, parseStoredFact } from './experience-store.ts';
import { StoryConflict } from './errors.ts';
import { settleResource, actionQuote } from '../content/resources.ts';

export const npcBatchSchema=z.object({actions:z.array(z.object({goalId:z.string(),text:z.string().min(1).max(600),usedFactIds:z.array(z.string().uuid()).max(20).default([]),changes:z.array(stateChangeSchema).max(3)}).strict()).max(2)}).strict();
type Batch=z.infer<typeof npcBatchSchema>;
export function dueGoals(context:RuntimeContext){
  const protagonist=context.characters.find(c=>c.importance==='protagonist')!;
  const seq=Math.max(0,...context.scenes.map(s=>s.seq));
  return (context.experience?.goals??[]).filter(g=>g.actorId!==protagonist.id&&['pending','warned'].includes(g.status))
    .filter(g=>g.status==='warned'?g.warningClock!==null&&context.clock>=g.warningClock+60&&seq>(g.warningSceneSeq??seq):context.clock>=g.dueMinutes||g.triggerStageId===context.stage?.id||g.triggerFactIds.some(id=>context.facts.some(f=>f.id===id)))
    .sort((a,b)=>a.dueMinutes-b.dueMinutes||a.id.localeCompare(b.id)).filter((g,i,all)=>all.findIndex(a=>a.actorId===g.actorId)===i).slice(0,2);
}
export function npcBoundary(context:RuntimeContext){
  const boundaries=(context.experience?.goals??[]).flatMap(g=>g.status==='warned'&&g.warningClock!==null&&g.warningClock+60>context.clock?[g.warningClock+60-context.clock]:g.status==='pending'&&g.irreversible&&g.dueMinutes>context.clock?[g.dueMinutes-context.clock]:[]);
  return boundaries.length?Math.min(...boundaries):1440;
}
export class NpcStore {
  constructor(readonly store:StoryStore){}
  async publicState(storyId:string){
    const context=await this.store.context(storyId),hero=context.characters.find(c=>c.importance==='protagonist');
    const visible=new Set(context.experience?.knowledge.filter(k=>k.characterId===hero?.id).map(k=>k.factId));
    const candidates=context.experience?.goals.filter(g=>g.warningFactId||g.evidenceFactIds.some(id=>visible.has(id)))??[];
    const ids=candidates.flatMap(g=>[...g.evidenceFactIds,...g.warningFactId?[g.warningFactId]:[]]);const facts=(await this.store.database.pool.query("SELECT id,text FROM facts WHERE story_id=$1 AND id=ANY($2::uuid[]) AND visibility<>'private'",[storyId,ids])).rows;
    return {knowledge:context.experience?.knowledge.filter(k=>k.characterId===hero?.id)??[],goals:candidates.flatMap(g=>{const source=facts.find(f=>f.id===g.warningFactId)??facts.find(f=>g.evidenceFactIds.includes(f.id)&&visible.has(f.id));return source?[{id:g.id,actorId:g.actorId,kind:g.kind,title:source.text,status:g.status,dueMinutes:g.dueMinutes,irreversible:g.irreversible,warningClock:g.warningClock,warningSceneSeq:g.warningSceneSeq,evidenceFactIds:[source.id]}]:[];}),clock:context.clock};
  }
  async prepare(turnId:string,context:RuntimeContext,plan:ScenePlan,generate:(goals:NpcGoal[])=>Promise<Batch>){
    if(plan.requiresPlayerChoice)return scenePlanSchema.parse({...plan,npcEffects:[]});
    let row=(await this.store.database.pool.query('SELECT data FROM npc_batches WHERE turn_id=$1',[turnId])).rows[0]?.data;
    if(!row){const goals=dueGoals(context);if(!goals.length)return plan;
      const result=npcBatchSchema.parse(await generate(goals));
      if(new Set(result.actions.map(a=>a.goalId)).size!==result.actions.length||result.actions.some(a=>!goals.some(g=>g.id===a.goalId)))throw new StoryConflict('INVALID_NPC_TRIGGER');
      row={goals,result,clock:context.clock};await this.store.database.pool.query('INSERT INTO npc_batches(turn_id,story_id,data) SELECT id,story_id,$2 FROM story_turns WHERE id=$1 ON CONFLICT DO NOTHING',[turnId,row]);
    }
    row.prepared??={};
    const seed=Number((await this.store.database.pool.query('SELECT seed FROM stories WHERE id=$1',[(await this.store.runtimeData(turnId)).storyId])).rows[0]?.seed);
    const oldIndices=new Set(plan.npcEffects.flatMap(e=>e.indices));
    const changes=plan.changes.filter((_,i)=>!oldIndices.has(i));const effects:ScenePlan['npcEffects']=[];
    const playerFrozen=(await this.store.database.pool.query('SELECT data FROM resource_attempts WHERE turn_id=$1',[turnId])).rows[0]?.data;
    let resourceCursor=playerFrozen?.resolved.state??context.experience?.resources;
    for(const action of row.result.actions as Batch['actions']){
      const goal=(row.goals as NpcGoal[]).find(g=>g.id===action.goalId)!;
      if(action.usedFactIds.some(id=>!context.experience?.knowledge.some(k=>k.characterId===goal.actorId&&k.factId===id)))throw new StoryConflict('NPC_UNKNOWN_KNOWLEDGE');
      if(!goal.irreversible&&action.changes.some(c=>majorPattern.test(JSON.stringify(c))||('significance' in c&&c.significance==='major')))throw new StoryConflict('NPC_WARNING_WINDOW_REQUIRED');
      const warning=goal.irreversible&&goal.status==='pending';
      const actor=context.characters.find(c=>c.id===goal.actorId);if(!actor)throw new StoryConflict('UNKNOWN_NPC');
      const selected=warning?[{type:'fact' as const,kind:'world' as const,text:`${context.characters.find(c=>c.importance==='protagonist')!.name}收到预警：${action.text}至少还剩一小时可以干预。`,tags:['npc_warning',goal.id,goal.actorId]}]:structuredClone(action.changes);
      if(!warning&&selected.some(c=>c.type==='character'&&c.characterId!==goal.actorId))throw new StoryConflict('NPC_CANNOT_CONTROL_OTHER_CHARACTER');
      if(!warning&&goal.action){
        const frozen=(await this.store.database.pool.query('SELECT data FROM resource_attempts WHERE turn_id=$1',[turnId])).rows[0]?.data;
        const resources=resourceCursor;
        if(!resources)throw new StoryConflict('NPC_RESOURCES_NOT_ENABLED');
        let quote;try{quote=actionQuote(resources,goal.action,[...context.facts,...context.evidenceFacts,...context.relevantFacts??[]]);}catch{continue;}
        if(quote.minutes>plan.durationMinutes)continue;
        // Consequences of the registered action are generated by the same engine at commit.
        if(selected.length)throw new StoryConflict('NPC_RESOURCE_EFFECTS_MUST_BE_ENGINE_GENERATED');
        const resolved=row.prepared[goal.id]?.resolved??settleResource(resources,goal.action,seed,turnId,[...context.facts,...context.evidenceFacts,...context.relevantFacts??[]]);
        row.prepared[goal.id]={before:digest(resources),resolved};resourceCursor=resolved.state;
        selected.push({type:'fact',kind:'world',text:`${actor.name}的${resolved.attempt.result}`,tags:['npc_action',goal.id,'resource_result']});
      }
      if(!selected.length)continue;
      if(changes.length+selected.length>16)break;
      const indices=selected.map((_,i)=>changes.length+i);changes.push(...selected);effects.push({goalId:goal.id,indices,warning});
    }
    row.effects=effects.map(effect=>({...effect,changes:effect.indices.map(i=>changes[i])}));await this.store.database.pool.query('UPDATE npc_batches SET data=$2 WHERE turn_id=$1',[turnId,row]);
    return scenePlanSchema.parse({...plan,changes,npcEffects:effects});
  }
  async permittedIndices(client:PoolClient,storyId:string,turnId:string,plan:ScenePlan){
    if(!plan.npcEffects.length)return [];
    const row=(await client.query('SELECT data FROM npc_batches WHERE turn_id=$1 AND story_id=$2',[turnId,storyId])).rows[0]?.data;if(!row)throw new StoryConflict('NPC_BATCH_NOT_PREPARED');
    const state=await this.store.experience.state(storyId,client);const result:number[]=[];
    const sceneSeq=Number((await client.query('SELECT count(*) AS n FROM scenes WHERE story_id=$1',[storyId])).rows[0].n);
    const clock=Number((await client.query('SELECT clock FROM stories WHERE id=$1',[storyId])).rows[0].clock);
    for(const effect of plan.npcEffects){const goal=state.goals.find(g=>g.id===effect.goalId),action=(row.result.actions as Batch['actions']).find(a=>a.goalId===effect.goalId);if(!goal||!action)throw new StoryConflict('UNKNOWN_NPC_TRIGGER');
      if(digest(effect.indices.map(i=>plan.changes[i]))!==digest(row.effects?.find((e:any)=>e.goalId===goal.id)?.changes))throw new StoryConflict('NPC_EFFECT_CHANGED');
      if(effect.warning){if(!goal.irreversible||goal.status!=='pending'||effect.indices.length!==1||plan.changes[effect.indices[0]]?.type!=='fact'||!(plan.changes[effect.indices[0]] as any).tags.includes('npc_warning'))throw new StoryConflict('INVALID_NPC_WARNING');result.push(...effect.indices);continue;}
      if(goal.irreversible&&!(goal.status==='warned'&&goal.warningFactId&&goal.warningClock!==null&&clock>=goal.warningClock+60&&sceneSeq>(goal.warningSceneSeq??sceneSeq)))throw new StoryConflict('NPC_WARNING_WINDOW_REQUIRED');
      if(digest(effect.indices.map(i=>plan.changes[i]))!==digest(row.effects?.find((e:any)=>e.goalId===goal.id)?.changes))throw new StoryConflict('NPC_EFFECT_CHANGED');
      result.push(...effect.indices);
    }return result;
  }
  async commit(client:PoolClient,storyId:string,turnId:string,plan:ScenePlan,facts:CanonicalFact[],review:StageReview|undefined,endTime:number){
    const state=await this.store.experience.state(storyId,client);let changed=false;
    const known=(id:string,factId:string)=>state.knowledge.some(k=>k.characterId===id&&k.factId===factId);
    const existing=async(id:string)=>(await client.query('SELECT * FROM facts WHERE id=$1 AND story_id=$2',[id,storyId])).rows.map(parseStoredFact)[0];
    const characters=(await client.query('SELECT id,data FROM characters WHERE story_id=$1',[storyId])).rows;const hero=characters.find(c=>c.data.importance==='protagonist')!.id;
    const add=(characterId:string,fact:CanonicalFact,mode:'observed'|'reported'|'inferred',sourceCharacterId:string|null=null)=>{if(!characters.some(c=>c.id===characterId))throw new StoryConflict('UNKNOWN_KNOWLEDGE_ACTOR');if(!known(characterId,fact.id)){state.knowledge.push({id:`knowledge_${digest([characterId,fact.id,mode]).slice(0,24)}`,characterId,factId:fact.id,mode,belief:'accepted',concealed:false,sourceCharacterId,learnedAt:endTime});changed=true;}};
    for(const [index,fact] of facts.entries()){
      const change=plan.changes[index];if(change.type==='character')add(change.characterId,fact,'observed');
      if(fact.visibility!=='private')add(hero,fact,fact.kind==='dialogue'?'reported':'observed');
      const observation=plan.observations.find(o=>o.changeIndex===index);if(observation?.speakerId&&!characters.some(c=>c.id===observation.speakerId))throw new StoryConflict('UNKNOWN_SPEAKER');
      for(const id of observation?.witnessIds??[]){if(!plan.participants.includes(id))throw new StoryConflict('WITNESS_NOT_PRESENT');add(id,fact,fact.kind==='dialogue'?'reported':'observed',observation?.speakerId??null);}
      for(const id of observation?.recipientIds??[])add(id,fact,'reported',observation?.speakerId??null);
    }
    for(const update of plan.knowledgeUpdates){const fact=update.evidence.type==='change'?facts[update.evidence.index]:await existing(update.evidence.factId);if(!fact)throw new StoryConflict('UNKNOWN_KNOWLEDGE_EVIDENCE');
      if(update.mode==='observed'&&!known(update.characterId,fact.id))throw new StoryConflict('KNOWLEDGE_OBSERVATION_UNPROVEN');
      if(update.mode==='reported'&&(!update.sourceCharacterId||!known(update.sourceCharacterId,fact.id)||!plan.observations.some(o=>o.speakerId===update.sourceCharacterId&&o.recipientIds.includes(update.characterId)&&(plan.changes[o.changeIndex]?.type==='fact'&&(plan.changes[o.changeIndex] as any).text.includes(fact.text)))))throw new StoryConflict('KNOWLEDGE_TRANSFER_UNPROVEN');
      if(update.mode==='inferred'&&!known(update.characterId,fact.id))throw new StoryConflict('INFERENCE_REQUIRES_KNOWN_SOURCE');
      add(update.characterId,fact,update.mode,update.sourceCharacterId);const entry=state.knowledge.find(k=>k.characterId===update.characterId&&k.factId===fact.id)!;Object.assign(entry,{mode:update.mode,belief:update.belief,concealed:update.concealed});changed=true;
    }
    for(const use of plan.npcUses)if(!known(use.characterId,use.factId)||!plan.changes[use.changeIndex])throw new StoryConflict('NPC_UNKNOWN_KNOWLEDGE');
    for(const update of review?.npcGoals??[]){if(update.actorId===hero||!characters.some(c=>c.id===update.actorId))throw new StoryConflict('INVALID_NPC_GOAL_ACTOR');
      const evidence:CanonicalFact[]=[];for(const ref of update.evidence){const fact=ref.type==='change'?facts[ref.index]:await existing(ref.factId);if(!fact||!['fact','character','relationship'].includes(String(fact.payload?.type)))throw new StoryConflict('INVALID_NPC_GOAL_EVIDENCE');evidence.push(fact);}
      for(const factId of update.triggerFactIds)if(!await existing(factId))throw new StoryConflict('UNKNOWN_NPC_TRIGGER_EVIDENCE');if(update.triggerStageId&&!(await client.query('SELECT id FROM story_stages WHERE id=$1 AND story_id=$2',[update.triggerStageId,storyId])).rows.length)throw new StoryConflict('UNKNOWN_NPC_TRIGGER_STAGE');
      const prior=state.goals.find(g=>g.id===update.id);if(prior){if(update.cancel&&prior.status!=='completed')prior.status='cancelled';else if(!update.cancel&&(prior.actorId!==update.actorId||prior.title!==update.title||prior.dueMinutes!==update.dueMinutes||digest(prior.action)!==digest(update.action)))throw new StoryConflict('NPC_GOAL_ALREADY_REGISTERED');}
      else {const {evidence:refs,cancel,...fields}=update;state.goals.push(npcGoalSchema.parse({...fields,evidenceFactIds:evidence.map(f=>f.id)}));}changed=true;
    }
    const seq=Number((await client.query('SELECT count(*) AS n FROM scenes WHERE story_id=$1',[storyId])).rows[0].n)+1;
    for(const effect of plan.npcEffects){const goal=state.goals.find(g=>g.id===effect.goalId)!;
      if(effect.warning){const fact=facts[effect.indices[0]];goal.status='warned';goal.warningFactId=fact.id;goal.warningClock=endTime;goal.warningSceneSeq=seq;}
      else {if(goal.action&&state.resources){const row=(await client.query('SELECT data FROM npc_batches WHERE turn_id=$1',[turnId])).rows[0]?.data;const prepared=row?.prepared?.[goal.id];if(!prepared||prepared.before!==digest(state.resources))throw new StoryConflict('NPC_RESOURCE_QUOTE_STALE');state.resources=prepared.resolved.state;}goal.status='completed';}
      changed=true;
    }
    if(changed)await this.store.experience.save(client,storyId,state,'人物知识与自主行动已更新',turnId);
  }
}
