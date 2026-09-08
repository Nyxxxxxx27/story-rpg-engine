import type { OutlineDraft, StoryStage } from '../contracts/index.ts';
import type { ExperienceState, StageGraph } from '../contracts/experience.ts';
import { StoryConflict } from './errors.ts';

export function validateGraph(outline: OutlineDraft) {
  if (!outline.graph) return;
  const ids = outline.stages.map(stage => stage.nodeId);
  if (ids.some(id => !id) || new Set(ids).size !== ids.length || !ids.includes(outline.graph.entry)) throw new StoryConflict('INVALID_STAGE_GRAPH_NODES');
  const routes = outline.graph.routes;
  if (new Set(routes.map(r => r.id)).size !== routes.length) throw new StoryConflict('DUPLICATE_ROUTE');
  for (const route of routes) if (!ids.includes(route.from) || !ids.includes(route.to) || route.from === route.to || (route.fallback && route.condition)||(!route.fallback&&!route.condition)) throw new StoryConflict('INVALID_STAGE_ROUTE');
  for(const route of routes)for(const test of route.condition?.tests??[]){if(test.type==='assertion'&&!outline.assertionDefinitions.some(a=>a.key===test.key))throw new StoryConflict('UNKNOWN_BRANCH_ASSERTION');if(test.type==='milestone'&&!outline.stages.find(s=>s.nodeId===route.from)?.milestoneIds.includes(test.milestoneId))throw new StoryConflict('UNKNOWN_ROUTE_MILESTONE');}
  for (const stage of outline.stages) {
    const outgoing = routes.filter(r => r.from === stage.nodeId);
    if (stage.terminal ? outgoing.length !== 0 : outgoing.filter(r => r.fallback).length !== 1) throw new StoryConflict('ROUTE_FALLBACK_REQUIRED');
  }
  const visiting = new Set<string>(), visited = new Set<string>();
  const visit = (id:string) => { if(visiting.has(id)) throw new StoryConflict('CYCLIC_STAGE_GRAPH'); if(visited.has(id))return; visiting.add(id);for(const route of routes.filter(r=>r.from===id))visit(route.to);visiting.delete(id);visited.add(id); };
  visit(outline.graph.entry); if(visited.size!==ids.length)throw new StoryConflict('UNREACHABLE_STAGE');
}
export function eligibleRoutes(graph:StageGraph,stage:StoryStage,state:ExperienceState) {
  const outgoing=graph.routes.filter(r=>r.from===stage.nodeId);
  const matching=outgoing.filter(route=>!route.fallback && route.condition && (()=>{
    const results=route.condition.tests.map(test=>{
      if(test.type==='outcome')return !!stage.outcome&&test.values.includes(stage.outcome);
      if(test.type==='milestone'){const milestone=stage.milestones.find(m=>m.id===test.milestoneId);return !!milestone&&(milestone.status==='achieved')===test.achieved;}
      const assertion=Object.hasOwn(state.assertions,test.key)?state.assertions[test.key]:null;return !!assertion&&assertion.evidenceFactIds.length>0&&assertion.value===test.value;
    });return route.condition!.mode==='all'?results.every(Boolean):results.some(Boolean);
  })());
  return matching.length?matching:outgoing.filter(r=>r.fallback);
}
export function witnessGraph() {
  const stage = (nodeId:string,title:string,objective:string,terminal=false) => ({nodeId,title,objective,completionCriteria:[objective,'确认本阶段行动造成的实际结果'],entryCriteria:[],failureConditions:['证人被敌方永久转移且营救窗口已经关闭'],boundaries:['主角重大行动由玩家确认'],desiredBeats:['以实际证据推进'],terminal,deadlineMinutes:null,entryBudgetMinutes:null});
  return {
    assertionDefinitions:[{key:'witness_rescued',description:'已有实际事件证明证人获救并处于安全状态'},{key:'rescue_failed',description:'已有实际事件证明本次营救失败，不能从缺少成功记录推断'},{key:'tracking_clue',description:'已经取得可用于追踪幕后主使的具体线索'}],
    stages:[stage('arrival','失踪的证人','找到证人被拘留的位置'),stage('rescue','营救窗口','救出证人并确认其安全'),stage('escort','护送线','将获救证人护送到安全地点'),stage('pursuit','追凶线','沿已取得的追踪线索找到幕后主使'),stage('remedy','补救调查','补齐缺失证据并建立新的调查方向'),stage('safe_end','证言留存','保全证言并完成公开记录',true),stage('justice_end','追查到底','提交经过核实的幕后主使证据',true),stage('open_end','未尽之事','记录已保全证据和未解决事项',true)],
    graph:{revision:1,entry:'arrival',routes:[
      {id:'arrival_rescue',from:'arrival',to:'rescue',label:'进入营救窗口',fallback:true,condition:null},
      {id:'rescue_escort',from:'rescue',to:'escort',label:'护送获救证人',fallback:false,condition:{mode:'all' as const,tests:[{type:'assertion' as const,key:'witness_rescued',value:true}]}},
      {id:'rescue_pursuit',from:'rescue',to:'pursuit',label:'循线追查',fallback:false,condition:{mode:'all' as const,tests:[{type:'assertion' as const,key:'rescue_failed',value:true},{type:'assertion' as const,key:'tracking_clue',value:true}]}},
      {id:'rescue_remedy',from:'rescue',to:'remedy',label:'补救调查',fallback:true,condition:null},
      {id:'escort_end',from:'escort',to:'safe_end',label:'保全证言',fallback:true,condition:null},
      {id:'pursuit_end',from:'pursuit',to:'justice_end',label:'提交证据',fallback:true,condition:null},
      {id:'remedy_end',from:'remedy',to:'open_end',label:'记录未尽之事',fallback:true,condition:null},
    ]},
  };
}
