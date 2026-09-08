import { createHash } from 'node:crypto';
import { resourcePanelSchema,resourceStateSchema,actionQuoteSchema, type ResourceState, type ResourceIntent, type ResourcePanel, type Challenge } from '../contracts/experience.ts';
import type { Character, StoryWorldConfig, CanonicalFact } from '../contracts/index.ts';
import { digest } from '../storage/experience-store.ts';
import { StoryConflict } from '../storage/errors.ts';

const recipes = {
  sneak:{cost:10,minutes:20,attribute:'physical',skill:'sneak',label:'潜入'},
  negotiate:{cost:5,minutes:15,attribute:'social',skill:'negotiate',label:'交涉'},
  force:{cost:20,minutes:10,attribute:'physical',skill:'force',label:'强攻'},
  investigate:{cost:5,minutes:15,attribute:'insight',skill:'investigate',label:'调查'},
  technique:{cost:10,minutes:20,attribute:'insight',skill:'specialty',label:'施展术式'},
  unlock:{cost:5,minutes:15,attribute:'insight',skill:'specialty',label:'开锁法术'},
  hack:{cost:5,minutes:15,attribute:'insight',skill:'specialty',label:'设备入侵'},
} as const;
export function initialResources(config:StoryWorldConfig,characters:Character[]):ResourceState {
  const panels=Object.fromEntries(characters.map(c=>[c.id,resourcePanelSchema.parse({})]));
  const methods:ResourceIntent['method'][]=['sneak','negotiate','force','investigate',...(config.genre==='cultivation'?['technique' as const]:config.genre==='western_fantasy'?['unlock' as const]:config.genre==='science_fiction'?['hack' as const]:[])];
  const challenge=(id:string,title:string,available:ResourceIntent['method'][]):Challenge=>({id,title,difficulty:'normal',methods:available,requiredItemId:null,revision:1,evidenceFactIds:[],price:0,rewardMoney:0,itemId:null,ownerId:null,facility:false,rewardClaimed:false,state:'open'});
  return {alerts:{},enabled:true,ruleset:config.genre,version:1,panels,items:config.genre==='science_fiction'?[{id:'toolkit',name:'便携技术工具',ownerId:characters.find(c=>c.importance==='protagonist')!.id,consumed:false}]:[],challenges:[challenge('local_obstacle','当前阶段的主要障碍',methods),{...challenge('charging_station','已确认可用的充能设备',['recharge']),facility:true}],attempts:[]};
}
export function actionQuote(state:ResourceState,intent:ResourceIntent,facts:CanonicalFact[]=[]) {
  if(!state.enabled)throw new StoryConflict('RESOURCES_NOT_ENABLED');
  const panel=Object.hasOwn(state.panels,intent.actorId)?state.panels[intent.actorId]:null;
  if(!panel)throw new StoryConflict('UNKNOWN_RESOURCE_ACTOR');
  const recipe=Object.hasOwn(recipes,intent.method)?recipes[intent.method as keyof typeof recipes]:null;
  const challenge=state.challenges.find(c=>c.id===intent.targetId);
  const owned=(id:string|null)=>id&&state.items.some(i=>i.id===id&&i.ownerId===intent.actorId&&!i.consumed);
  const restore=['rest','long_rest','meditate','illuminate','shield','treat'].includes(intent.method);
  if(!restore&&(!challenge||!challenge.methods.includes(intent.method)))throw new StoryConflict('UNREGISTERED_ACTION');
  if(challenge?.requiredItemId&&!owned(challenge.requiredItemId))throw new StoryConflict('REQUIRED_ITEM_MISSING');
  if(panel.injury>=3&&recipe)throw new StoryConflict('ACTOR_INCAPACITATED');
  if(['technique','meditate'].includes(intent.method)&&state.ruleset!=='cultivation')throw new StoryConflict('WRONG_RULESET');
  if(['illuminate','shield','unlock'].includes(intent.method)&&state.ruleset!=='western_fantasy')throw new StoryConflict('WRONG_RULESET');
  if(['hack','recharge'].includes(intent.method)&&state.ruleset!=='science_fiction')throw new StoryConflict('WRONG_RULESET');
  if(intent.method==='technique'&&panel.energy<5)throw new StoryConflict('INSUFFICIENT_ENERGY');
  if(['illuminate','shield','unlock'].includes(intent.method)&&panel.spellSlots<1)throw new StoryConflict('NO_SPELL_SLOT');
  if(intent.method==='hack'&&(!owned(intent.itemId)||panel.energy<10))throw new StoryConflict('HACK_TOOL_OR_ENERGY_REQUIRED');
  if(intent.method==='recharge'&&!challenge?.facility)throw new StoryConflict('CHARGER_REQUIRED');
  if(intent.method==='treat'&&(!owned(intent.itemId)||!intent.itemId?.startsWith('medical_')))throw new StoryConflict('MEDICAL_ITEM_REQUIRED');
  if(!['hack','treat'].includes(intent.method)&&intent.itemId!==null)throw new StoryConflict('UNUSED_ITEM_ARGUMENT');
  if(intent.method==='trade'&&(!challenge?.itemId||!challenge.ownerId||!state.items.some(i=>i.id===challenge.itemId&&i.ownerId===challenge.ownerId&&!i.consumed)||panel.money<challenge.price))throw new StoryConflict('TRADE_PRECONDITION_FAILED');
  if(intent.method==='reward'&&(!challenge||challenge.rewardClaimed||challenge.state!=='passed'||!challenge.evidenceFactIds.length||challenge.evidenceFactIds.some(id=>!facts.some(f=>f.id===id&&f.kind!=='dialogue'))))throw new StoryConflict('REWARD_EVIDENCE_REQUIRED');
  const cost=recipe?.cost??0,minutes=recipe?.minutes??(intent.method==='long_rest'?480:['rest','meditate','recharge','treat'].includes(intent.method)?30:5);
  if(panel.stamina<cost)throw new StoryConflict('INSUFFICIENT_STAMINA');
  const sources=facts.filter(f=>intent.evidenceFactIds.includes(f.id)&&f.kind!=='dialogue'&&f.visibility!=='private'&&!/据说|声称|可能|未确认/.test(f.text));
  const corroborated=state.ruleset==='modern_mystery'&&sources.every(f=>challenge?.evidenceFactIds.includes(f.id))&&new Set(sources.map(f=>f.sourceTurnId)).size>=2;
  const bonus=(intent.method==='technique'?2:0)+(panel.illuminated&&['investigate','unlock'].includes(intent.method)?1:0)+(corroborated&&['investigate','negotiate'].includes(intent.method)?2:0);
  const modifier=recipe?panel.attributes[recipe.attribute]+panel.skills[recipe.skill]-Math.min(4,panel.injury*2)+bonus:0;
  const dc=recipe?({easy:10,normal:14,hard:18}[challenge!.difficulty]):null;
  const probability=dc===null?1:Math.max(0,Math.min(20,21-dc+modifier))/20;
  const money=intent.method==='trade'?challenge!.price:0;
  return {intent,cost,minutes,modifier,dc,probability,money,requiresConfirmation:cost>=30||(money>0&&money>=panel.money*.25)||intent.method==='treat'||(intent.method==='force'&&panel.injury>=2),label:recipe?.label??({rest:'休息',long_rest:'长休',meditate:'调息',illuminate:'照明',shield:'护盾',recharge:'充能',treat:'治疗',trade:'交易',reward:'领取奖励'} as Record<string,string>)[intent.method],
    fingerprint:digest({ruleset:state.ruleset,version:state.version,intent:{...intent,evidenceFactIds:undefined},challenge:challenge?{id:challenge.id,revision:challenge.revision,difficulty:challenge.difficulty}:null,attributes:panel.attributes,skills:panel.skills,injury:panel.injury,bonus,evidence:sources.map(f=>f.text).sort()})};
}
export function fixedRoll(seed:number,fingerprint:string) {
  let counter=0,value:number; do {value=createHash('sha256').update(`${seed}:${fingerprint}:${counter++}`).digest().readUInt32BE(0);}while(value>=Math.floor(2**32/20)*20);
  return value%20+1;
}
export function resourceCostNotes(state:ResourceState,intent:ResourceIntent){
  const notes:string[]=[];
  if(intent.method==='technique')notes.push('消耗灵力 5');
  if(intent.method==='hack')notes.push('消耗电量 10；失败增加追踪程度');
  if(['illuminate','shield','unlock'].includes(intent.method))notes.push('消耗法术槽 1');
  if(intent.method==='treat')notes.push(`消耗物品：${state.items.find(i=>i.id===intent.itemId)?.name??intent.itemId}，使用后不可再用`);
  if(intent.method==='force')notes.push('失败可能增加伤势');
  return notes;
}
export function settleResource(stateInput:ResourceState,intent:ResourceIntent,seed:number,turnId:string,facts:CanonicalFact[]=[]) {
  const previous=stateInput.attempts.find(a=>a.turnId===turnId&&a.intent.actorId===intent.actorId&&a.committed);
  if(previous) {if(digest(previous.intent)!==digest(intent))throw new StoryConflict('FROZEN_ACTION_CHANGED');if(!previous.quote)throw new StoryConflict('LEGACY_QUOTE_UNAVAILABLE');return {state:structuredClone(stateInput),attempt:previous,quote:actionQuoteSchema.parse(previous.quote)};}
  const state=structuredClone(stateInput),quote=actionQuote(state,intent,facts),panel=state.panels[intent.actorId];
  const key=digest({fingerprint:quote.fingerprint,seed,...(quote.dc===null?{turnId}: {})});
  const prior=state.attempts.find(a=>a.key===key&&a.committed);
  if(prior) {if(prior.turnId===turnId)return {state,attempt:prior,quote};throw new StoryConflict('ACTION_ALREADY_RESOLVED_CHANGE_APPROACH');}
  const roll=quote.dc===null?null:fixedRoll(seed,quote.fingerprint),success=roll===null||roll+quote.modifier>=quote.dc!;
  panel.stamina-=quote.cost;
  if(intent.method==='rest')panel.stamina=Math.min(100,panel.stamina+30);
  if(intent.method==='long_rest'){panel.stamina=100;panel.illuminated=false;if(state.ruleset==='western_fantasy')panel.spellSlots=3;}
  if(intent.method==='meditate')panel.energy=Math.min(30,panel.energy+10);
  if(intent.method==='technique')panel.energy-=5;
  if(['illuminate','shield','unlock'].includes(intent.method))panel.spellSlots--;
  if(intent.method==='shield')panel.shield=true;
  if(intent.method==='illuminate')panel.illuminated=true;
  if(intent.method==='hack'){panel.energy-=10;if(!success)panel.trace=Math.min(3,panel.trace+1);}
  if(intent.method==='recharge')panel.energy=Math.min(30,panel.energy+10);
  if(intent.method==='treat'){panel.injury=Math.max(0,panel.injury-1);state.items.find(i=>i.id===intent.itemId)!.consumed=true;}
  if(!success&&intent.method==='sneak')state.alerts[intent.targetId]=Math.min(3,(state.alerts[intent.targetId]??0)+1);
  if(!success&&intent.method==='force'){if(panel.shield)panel.shield=false;else panel.injury=Math.min(3,panel.injury+1);}
  const challenge=state.challenges.find(c=>c.id===intent.targetId);
  if(intent.method==='trade'){panel.money-=challenge!.price;if(challenge!.ownerId&&state.panels[challenge!.ownerId])state.panels[challenge!.ownerId].money+=challenge!.price;state.items.find(i=>i.id===challenge!.itemId)!.ownerId=intent.actorId;}
  if(intent.method==='reward'){challenge!.rewardClaimed=true;panel.money+=challenge!.rewardMoney;if(challenge!.itemId){const item=state.items.find(i=>i.id===challenge!.itemId);if(!item||item.consumed||item.ownerId!==challenge!.ownerId)throw new StoryConflict('REWARD_ITEM_UNAVAILABLE');item.ownerId=intent.actorId;}}
  if(challenge&&quote.dc!==null)challenge.state=success?'passed':'failed';
  const result=quote.dc===null?`${quote.label}已完成。`:`${quote.label}${success?'成功':'受挫'}。${!success?(intent.method==='force'?'伤势需要处理。':intent.method==='sneak'?'行踪已暴露，需要寻找其他办法。':intent.method==='negotiate'?'对方拒绝了当前条件，需要调整交涉方式。':'当前证据不足，需要寻找新的依据。'):''}`;
  const attempt={key,intent,roll,success,result,cost:quote.cost,minutes:quote.minutes,committed:true,turnId,fingerprint:quote.fingerprint,quote};
  state.attempts.push(attempt);return {state:resourceStateSchema.parse(state),attempt,quote};
}
