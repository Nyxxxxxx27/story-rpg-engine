import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { decisionSchema, sceneSchema, storyStageSchema, type Scene } from '../contracts/index.ts';
import { initializeMilestones, legacyDeadline } from './stages.ts';
import type { Database } from './database.ts';

export function sceneOptions(sceneId: string, choices: string[]) {
  return [...new Set(choices)].map(text => ({ id: `option_${createHash('sha256').update(`${sceneId}:${text}`).digest('hex').slice(0, 24)}`, text }));
}

export async function migrateV2(database: Database) {
  await database.pool.query(`
    ALTER TABLE stories ADD COLUMN IF NOT EXISTS schema_version integer NOT NULL DEFAULT 1;
    ALTER TABLE story_turns ADD COLUMN IF NOT EXISTS decision_id uuid;
    ALTER TABLE story_turns ADD COLUMN IF NOT EXISTS narration_state jsonb;
    ALTER TABLE story_turns ADD COLUMN IF NOT EXISTS narration_retry boolean NOT NULL DEFAULT false;
    ALTER TABLE story_turns ADD COLUMN IF NOT EXISTS resume_status text;
    CREATE TABLE IF NOT EXISTS story_decisions(id uuid PRIMARY KEY,story_id uuid NOT NULL REFERENCES stories(id) ON DELETE CASCADE,scene_id uuid NOT NULL UNIQUE,turn_id uuid NOT NULL UNIQUE,data jsonb NOT NULL);
    CREATE UNIQUE INDEX IF NOT EXISTS decision_pending_idx ON story_decisions(story_id) WHERE data->>'status'='pending';
    CREATE TABLE IF NOT EXISTS story_requests(story_id uuid NOT NULL REFERENCES stories(id) ON DELETE CASCADE,key text NOT NULL,response jsonb NOT NULL,PRIMARY KEY(story_id,key));
    CREATE TABLE IF NOT EXISTS story_save_backups(story_id uuid NOT NULL,version integer NOT NULL,snapshot jsonb NOT NULL,created_at bigint NOT NULL,PRIMARY KEY(story_id,version));
    CREATE TABLE IF NOT EXISTS narration_attempts(id uuid PRIMARY KEY,turn_id uuid NOT NULL REFERENCES story_turns(id) ON DELETE CASCADE,data jsonb NOT NULL,created_at bigint NOT NULL);
  `);
  const legacy = await database.pool.query('SELECT id FROM stories WHERE schema_version<2 ORDER BY id');
  for (const { id } of legacy.rows) {
    const client = await database.pool.connect();
    try {
      await client.query('BEGIN');
      const locked = await client.query('SELECT * FROM stories WHERE id=$1 FOR UPDATE', [id]);
      const story = locked.rows[0];
      if (story.schema_version >= 2) { await client.query('COMMIT'); continue; }
      const snapshot: Record<string, unknown> = { stories: [story] };
      for (const table of ['story_stages', 'characters', 'relationships', 'story_turns', 'facts', 'scenes', 'stage_proposals', 'autoplay_sessions', 'prompt_revisions']) {
        snapshot[table] = (await client.query(`SELECT * FROM ${table} WHERE story_id=$1`, [id])).rows;
      }
      snapshot.turn_steps = (await client.query('SELECT * FROM turn_steps WHERE turn_id IN (SELECT id FROM story_turns WHERE story_id=$1)', [id])).rows;
      snapshot.story_outbox = (await client.query('SELECT * FROM story_outbox WHERE turn_id IN (SELECT id FROM story_turns WHERE story_id=$1)', [id])).rows;
      await mkdir(database.backupDirectory, { recursive: true });
      // Versioned snapshots are written before any game projection is changed.
      await writeFile(join(database.backupDirectory, `${id}-v1.json`), JSON.stringify(snapshot, null, 2), { encoding: 'utf8', flag: 'wx' }).catch(error => { if (error.code !== 'EEXIST') throw error; });
      await client.query('INSERT INTO story_save_backups(story_id,version,snapshot,created_at) VALUES($1,1,$2,$3) ON CONFLICT DO NOTHING', [id, snapshot, Date.now()]);
      const stages = [];
      for (const row of snapshot.story_stages as any[]) {
        const old = storyStageSchema.parse(row.data);
        const stage = initializeMilestones({ ...old, deadlineMinutes: old.deadlineMinutes ?? legacyDeadline(old) });
        stage.legacyProgress = old.progress;
        stage.progress = old.status === 'completed' ? old.progress : 0;
        stage.outcome = old.status === 'completed' ? 'success' : old.status === 'failed' ? 'failure' : null;
        stage.awaitingDeadline = stage.status === 'active' && stage.deadlineMinutes !== null && Number(story.clock) >= stage.deadlineMinutes;
        stage.revision += 1;
        await client.query('UPDATE story_stages SET data=$2 WHERE id=$1', [stage.id, stage]);
        stages.push(stage);
      }
      const turns = snapshot.story_turns as any[];
      for (const turn of turns.filter(item => item.source === 'autoplay' && ['completed', 'waiting_player'].includes(item.status))) {
        await client.query('INSERT INTO story_requests(story_id,key,response) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [id, `autoplay-account:${turn.id}`, { accounted: true, legacy: true }]);
      }
      const latestWaiting = turns.filter(turn => turn.status === 'waiting_player').sort((a, b) => b.created_at - a.created_at)[0];
      const hasProposal = (snapshot.stage_proposals as any[]).some(item => item.status === 'pending');
      for (const row of snapshot.scenes as any[]) {
        const scene: Scene = sceneSchema.parse(row.data);
        scene.options = sceneOptions(scene.id, scene.choices);
        scene.published = turns.find(turn => turn.id === scene.turnId)?.status !== 'narrating';
        if (latestWaiting?.id === scene.turnId && !hasProposal) {
          scene.decisionId = randomUUID();
          const decision = decisionSchema.parse({ id: scene.decisionId, storyId: id, sceneId: scene.id, turnId: scene.turnId, stageId: story.active_stage_id, prompt: latestWaiting.waiting_reason ?? '请选择下一步行动', options: scene.options, status: 'pending', choice: null, continuationTurnId: null });
          await client.query('INSERT INTO story_decisions(id,story_id,scene_id,turn_id,data) VALUES($1,$2,$3,$4,$5)', [decision.id, id, scene.id, scene.turnId, decision]);
        }
        await client.query('UPDATE scenes SET data=$2 WHERE id=$1', [scene.id, scene]);
      }
      const active = stages.find(stage => stage.id === story.active_stage_id);
      const ended = active && ['completed', 'failed', 'closed'].includes(active.status) && !stages.some(stage => stage.position > active.position);
      const storyStatus = ended ? 'finished' : story.status;
      if (ended || active?.awaitingDeadline || hasProposal || latestWaiting) {
        await client.query("UPDATE autoplay_sessions SET data=jsonb_set(jsonb_set(data,'{status}',to_jsonb($2::text)),'{pauseReason}',to_jsonb('迁移后等待玩家继续'::text)) WHERE story_id=$1 AND data->>'status'='running'", [id, ended ? 'completed' : 'paused']);
        await client.query("UPDATE story_turns SET status='failed',current_step='failed',error='迁移后暂停托管，等待玩家继续' WHERE story_id=$1 AND source='autoplay' AND status='queued'", [id]);
      }
      const decisions = (await client.query('SELECT data FROM story_decisions WHERE story_id=$1', [id])).rows.map(row => row.data);
      const eventId = randomUUID();
      const seq = await client.query('UPDATE stories SET fact_seq=fact_seq+1,schema_version=2,revision=revision+1,status=$2 WHERE id=$1 RETURNING fact_seq', [id, storyStatus]);
      const eventSeq = seq.rows[0].fact_seq;
      await client.query('INSERT INTO facts(id,story_id,seq,time,kind,text,tags,visibility,source_turn_id,payload,created_at) VALUES($1,$2,$3,$4,\'stage\',\'存档结构升级为 v2\',$5,\'private\',$1,$6,$7)', [eventId, id, Number(eventSeq), Number(story.clock), ['migration'], { type: 'save_migrated', version: 2, stages, decisions, storyStatus, activeStageId: story.active_stage_id }, Date.now()]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }
}
