import {eligibleRoutes} from './branches.ts';
import {randomUUID} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import type {StoryStore} from './store.ts';
import {digest} from './experience-store.ts';
import {StoryConflict} from './errors.ts';

/** Reconstruct a selected historical node only when its initialization and event prefix exist. */
export async function rebuildCheckpoint(store:StoryStore,storyId:string,sceneId:string){
  const client=await store.database.pool.connect();
  try{
    await client.query('BEGIN');await client.query('SELECT id FROM stories WHERE id=$1 FOR UPDATE',[storyId]);
    const source=await store.experience.snapshot(client,storyId),row=source.tables.scenes.find(r=>r.id===sceneId);
    if(!row||row.data.published===false)throw new StoryConflict('CHECKPOINT_SCENE_NOT_COMPLETE');
    const eventIds=new Set(row.data.factIds);const cutoff=Math.max(0,...source.tables.facts.filter(f=>eventIds.has(f.id)).map(f=>Number(f.seq)));
    const facts=source.tables.facts.filter(f=>Number(f.seq)<=cutoff);
    if(!facts.some(f=>f.payload?.type==='experience_initialized'&&f.payload.characters)||!facts.some(f=>f.payload?.type==='story_initialized'&&f.payload.stages))throw new StoryConflict('CHECKPOINT_HISTORY_UNPROVEN','此节点缺少完整的初始化快照，可以继续阅读，但不能推测状态来创建分支。');
    const replay=(await store.stateHashes(storyId,client,cutoff)).projection!;
    const snapshot=structuredClone(source),tables=snapshot.tables;
    tables.facts=facts;tables.scenes=source.tables.scenes.filter(s=>s.seq<=row.seq);
    const turns=new Set(tables.scenes.map(s=>s.turn_id));tables.story_turns=source.tables.story_turns.filter(t=>turns.has(t.id)).map(t=>({...t,status:replay.decisions.some(d=>d.turnId===t.id&&d.status==='pending')?'waiting_player':'completed',current_step:'completed',error:null,import_suspended:false,narration_retry:false,narration_state:null,resume_status:null}));
    tables.characters=replay.characters.map(data=>({story_id:storyId,id:data.id,data}));
    tables.relationships=replay.relationships.map(data=>{const existing=source.tables.relationships.find(r=>r.from_id===data.from&&r.to_id===data.to);if(!existing)throw new StoryConflict('CHECKPOINT_RELATION_UNPROVEN');return {...existing,data:{...data,id:existing.id}};});
    tables.story_stages=replay.stages.map(data=>({id:data.id,story_id:storyId,position:data.position,data}));
    tables.story_decisions=replay.decisions.map(data=>({id:data.id,story_id:storyId,scene_id:data.sceneId,turn_id:data.turnId,data}));
    tables.story_experience=[{story_id:storyId,data:replay.features}];tables.prompt_revisions=source.tables.prompt_revisions.filter(r=>r.version<=replay.promptVersion);
    tables.resource_attempts=source.tables.resource_attempts.filter(r=>turns.has(r.turn_id));tables.npc_batches=source.tables.npc_batches.filter(r=>turns.has(r.turn_id));
    const active=replay.stages.find(s=>s.id===replay.activeStageId);const pendingRoutes=active?.outcome&&replay.outline.graph?eligibleRoutes(replay.outline.graph,active,replay.features):[];
    tables.stage_proposals=source.tables.stage_proposals.filter(p=>Number(p.created_at)<=Number(row.created_at)&&replay.stages.some(s=>s.id===p.stage_id&&(s.status!=='planned'||!!active?.outcome&&(replay.outline.graph?pendingRoutes.some(route=>route.id===p.route_id)&&p.graph_revision===replay.outline.graph.revision:s.position===active.position+1)))).map(p=>({...p,status:replay.stages.find(s=>s.id===p.stage_id)!.status==='planned'?'pending':'accepted',reviewed_at:replay.stages.find(s=>s.id===p.stage_id)!.status==='planned'?null:p.reviewed_at}));
    tables.autoplay_sessions=source.tables.autoplay_sessions.filter(s=>Number(s.created_at)<=Number(row.created_at)).map(s=>({...s,data:{...s.data,status:'paused',pauseReason:'从历史节点恢复后保持暂停',scenes:tables.story_turns.filter(t=>t.idempotency_key.startsWith(`autoplay:${s.id}:`)).length}}));
    Object.assign(snapshot.story,{config:replay.config,outline:replay.outline,arc:{objective:replay.outline.arcObjective,stakes:replay.outline.stakes},clock:replay.clock,status:replay.status,active_stage_id:replay.activeStageId,prompt_version:replay.promptVersion,fact_seq:cutoff,updated_at:row.created_at});delete snapshot.story.running_turn_id;
    // Future choice receipts and future task identities are excluded by construction.
    for(const turn of tables.story_turns){const pending=replay.decisions.find(d=>d.turnId===turn.id&&d.status==='pending');turn.waiting_reason=pending?.prompt??null;}
    const hash=digest(snapshot),id=randomUUID();
    const result=await client.query('INSERT INTO story_checkpoints(id,story_id,fact_seq,scene_seq,label,data,hash,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(story_id,hash) DO UPDATE SET hash=excluded.hash RETURNING id',[id,storyId,cutoff,row.seq,'从完整事件前缀重建',{encoding:'gzip-json-v1',body:gzipSync(JSON.stringify(snapshot)).toString('base64')},hash,Date.now()]);
    await client.query('COMMIT');return {checkpointId:result.rows[0].id,sceneSeq:row.seq,factSeq:cutoff};
  }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
}
