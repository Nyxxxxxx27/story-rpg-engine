import {rebuildCheckpoint} from '../packages/storage/checkpoint-rebuild.ts';
import { afterEach, expect, it } from 'vitest';
import { fixture, createActiveStory } from './helpers.ts';
import { StoryArchive } from '../packages/storage/archive.ts';
import { StoryRuntime } from '../packages/agent-runtime/runtime.ts';
import { deterministicProvider } from '../packages/agent-runtime/provider.ts';
import { storyDeterministicGenerator } from '../packages/agent-runtime/deterministic.ts';
import { digest } from '../packages/storage/experience-store.ts';
import { scenePlanSchema } from '../packages/contracts/index.ts';

const cleanups:Array<()=>Promise<void>>=[];
afterEach(async()=>{while(cleanups.length)await cleanups.pop()!();});
it('restores a committed but unpublished checkpoint only after an explicit narration resume',async()=>{
  const value=await fixture();cleanups.push(value.close);const id=await createActiveStory(value),context=await value.store.context(id),hero=context.characters[0];
  const turn=await value.store.enqueueTurn(id,'留下一条观察','test','missing-prose-original');await value.store.claim(turn.id);
  const plan=scenePlanSchema.parse({title:'观察',objective:'记录眼前情况',location:hero.location,participants:[hero.id],durationMinutes:5,beats:['观察'],changes:[{type:'fact',kind:'action',text:`${hero.name}记录了眼前灯光的变化。`,tags:['observation']}],requiresPlayerChoice:false,choicePrompt:null,choices:[],checkTags:[]});await value.store.setTurnData(turn.id,'plan',plan);await value.store.commitScene(turn.id,plan);
  const archive=new StoryArchive(value.store),save=await archive.export(id);expect(save.snapshot.story).not.toHaveProperty('running_turn_id');const restored=await archive.import('test',save,'missing-prose-restore');const state=await value.store.state(restored.storyId);expect(state.scenes).toHaveLength(0);
  const rows=(await value.database.pool.query('SELECT id FROM story_turns WHERE story_id=$1',[restored.storyId])).rows;await value.runtime.runTurn(rows[0].id);expect((await value.store.state(restored.storyId)).scenes).toHaveLength(0);
  await value.store.retryTurn(restored.storyId,rows[0].id,'missing-prose-resume');await value.runtime.runTurn(rows[0].id);const after=await value.store.state(restored.storyId);expect(after.scenes).toHaveLength(1);expect(after.clock).toBe(5);expect((await value.store.stateHashes(restored.storyId)).matches).toBe(true);
},60000);
it('exports, remaps and restores a checkpoint without executing any turn',async()=>{
  const value=await fixture();cleanups.push(value.close);const id=await createActiveStory(value);
  const turn=await value.store.enqueueTurn(id,'核对记录','test','archive-first-turn');await value.runtime.runTurn(turn.id);
  expect((await value.store.turn(turn.id)).status).toBe('completed');
  const archive=new StoryArchive(value.store), source=await archive.export(id);
  const restored=await archive.import('test',source,'archive-import-key');
  expect((await archive.import('test',source,'archive-import-key')).storyId).toBe(restored.storyId);
  const state=await value.store.state(restored.storyId);
  expect(state.scenes).toHaveLength(1);expect(state.scenes[0].id).not.toBe((await value.store.state(id)).scenes[0].id);
  expect(state.scenes[0].prose).toBe((await value.store.state(id)).scenes[0].prose);
  expect((await value.store.stateHashes(restored.storyId)).matches).toBe(true);
  await value.store.recoverInterrupted();await value.store.flushOutbox();
  expect((await value.database.pool.query('SELECT * FROM story_outbox o JOIN story_turns t ON t.id=o.turn_id WHERE t.story_id=$1 AND NOT dispatched',[restored.storyId])).rows).toHaveLength(0);
  const corrupted=structuredClone(source);corrupted.snapshot.tables.characters[0].data.mood='与事件不符';corrupted.hash=digest(corrupted.snapshot);
  await expect(archive.import('test',corrupted,'archive-corrupt-key')).rejects.toThrow('ARCHIVE_REPLAY_MISMATCH');
  expect((await value.store.list('test'))).toHaveLength(2);
},60000);

it('keeps an old waiting choice pending when forking after its original consequence',async()=>{
  const value=await fixture();cleanups.push(value.close);const id=await createActiveStory(value);
  const base=deterministicProvider(storyDeterministicGenerator);
  const runtime=new StoryRuntime(value.store,()=>({name:'deterministic',async run(role,prompt,schema,signal){const result:any=await base.run(role,prompt,schema,signal);if(role==='Director Agent'&&!prompt.includes('<confirmed_decision>'))return schema.parse({...result,requiresPlayerChoice:true,choicePrompt:'选择记录',choices:['核对北侧记录','核对南侧记录']});if(role==='Stage Agent')return schema.parse({...result,milestones:[]});return result;}}));
  const turn=await value.store.enqueueTurn(id,'讨论方向','test','archive-choice');await runtime.runTurn(turn.id);
  const pending=(await value.store.state(id)).pendingDecision!;expect(pending).not.toBeNull();
  const checkpoint=(await value.store.experience.checkpoints(id))[0];
  const resolved=await value.store.resolveChoice(id,{source:'test',decisionId:pending.id,optionId:pending.options[0].id,idempotencyKey:'original-choice'});await runtime.runTurn(resolved.continuationTurnId);
  const rebuilt=await rebuildCheckpoint(value.store,id,pending.sceneId);const archive=new StoryArchive(value.store);expect((await archive.export(id)).sceneSeq).toBe(2);const fork=await archive.fork('test',id,rebuilt.checkpointId,'archive-fork-key');
  const state=await value.store.state(fork.storyId);expect(state.pendingDecision?.status).toBe('pending');expect(state.scenes).toHaveLength(1);
  const second=await value.store.resolveChoice(fork.storyId,{source:'test',decisionId:state.pendingDecision!.id,optionId:state.pendingDecision!.options[1].id,idempotencyKey:'fork-choice-key'});await runtime.runTurn(second.continuationTurnId);
  expect((await value.store.state(fork.storyId)).scenes).toHaveLength(2);expect((await value.store.state(id)).scenes).toHaveLength(2);
},60000);
