import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { StoryStore } from '../../packages/storage/store.ts';
import type { StoryRuntime } from '../../packages/agent-runtime/runtime.ts';
import { StoryArchive } from '../../packages/storage/archive.ts';
import { outlineDraftSchema } from '../../packages/contracts/index.ts';
import { resourceIntentSchema } from '../../packages/contracts/experience.ts';
import { resourceSetupSchema } from '../../packages/storage/resource-store.ts';
import {rebuildCheckpoint} from '../../packages/storage/checkpoint-rebuild.ts';

export function experienceRoutes(app: FastifyInstance, store: StoryStore, runtime: StoryRuntime, owner: string) {
  const archives = new StoryArchive(store);
  const story = async (params: unknown) => { const { id } = z.object({ id: z.string().uuid() }).parse(params); await store.state(id, owner); return id; };
  app.get('/api/v2/stories/:id/history', async request => { const id = await story(request.params); const q = z.object({ cursor: z.string().max(1000).optional(), limit: z.coerce.number().int().min(1).max(100).default(20) }).parse(request.query); return store.experience.history(id, q.cursor, q.limit); });
  app.get('/api/v2/stories/:id/scenes/:sceneId', async request => { const id = await story(request.params); const { sceneId } = z.object({ sceneId: z.string().uuid() }).parse(request.params); return store.experience.scene(id, sceneId); });
  app.get('/api/v2/stories/:id/actions', async request => { const id = await story(request.params); const q = z.object({ before: z.coerce.number().int().positive().optional(),cursor:z.string().max(1000).optional() }).parse(request.query); return store.experience.actionPage(id,q.cursor,q.before); });
  app.get('/api/v2/stories/:id/chapters', async request => ({ chapters: await store.experience.chapters(await story(request.params)) }));
  app.post('/api/v2/stories/:id/chapters/:stageId/recap', async request => { const id = await story(request.params); const { stageId } = z.object({ stageId: z.string().uuid() }).parse(request.params); return runtime.generateRecap(id, stageId); });
  app.get('/api/v2/stories/:id/memory', async request => { const id = await story(request.params); const q = z.object({ q: z.string().max(4000).default('') }).parse(request.query); const context = await store.context(id, q.q); return { facts: (context.relevantFacts ?? []).filter(f => f.visibility !== 'private'), threads: (context.experience?.threads ?? []).filter(t => t.visibility !== 'private'), hits: context.memoryHits, job: await store.experience.memoryStatus(id) }; });
  app.post('/api/v2/stories/:id/memory/index', async request => { const id = await story(request.params); const { action } = z.object({ action: z.enum(['pause', 'resume']) }).strict().parse(request.body); return store.experience.memoryStatus(id, action); });
  app.get('/api/v2/stories/:id/checkpoints', async request => ({ checkpoints: await store.experience.checkpoints(await story(request.params)) }));
  app.post('/api/v2/stories/:id/checkpoints/rebuild',async request=>{const id=await story(request.params);const {sceneId}=z.object({sceneId:z.string().uuid()}).strict().parse(request.body);return rebuildCheckpoint(store,id,sceneId);});
  app.get('/api/v2/stories/:id/save', async request => { const id = await story(request.params); const q = z.object({ checkpointId: z.string().uuid().optional() }).parse(request.query); return archives.export(id,q.checkpointId); });
  app.post('/api/v2/saves/import', { bodyLimit: 100_000_000 }, async request => { const body = z.object({ archive: z.unknown(), idempotencyKey: z.string().min(8).max(120) }).strict().parse(request.body); return archives.import(owner,body.archive,body.idempotencyKey); });
  app.post('/api/v2/stories/:id/forks', async request => { const id = await story(request.params); const body = z.object({ checkpointId: z.string().uuid(), idempotencyKey: z.string().min(8).max(120) }).strict().parse(request.body); return archives.fork(owner,id,body.checkpointId,body.idempotencyKey); });
  app.put('/api/v2/stories/:id/graph',async request=>{const id=await story(request.params);const body=z.object({revision:z.number().int().positive(),outline:outlineDraftSchema}).strict().parse(request.body);return store.editGraph(id,body.revision,body.outline);});
  app.get('/api/v2/stories/:id/recovery',async request=>{const id=await story(request.params);return {turns:(await store.database.pool.query('SELECT t.id,t.input,t.status,(SELECT s.id FROM scenes s WHERE s.turn_id=t.id) AS scene_id FROM story_turns t WHERE story_id=$1 AND import_suspended ORDER BY created_at',[id])).rows};});
  app.get('/api/v2/stories/:id/resources',async request=>store.resources.panel(await story(request.params)));
  app.post('/api/v2/stories/:id/resources/quote',async request=>store.resources.quote(await story(request.params),resourceIntentSchema.parse(request.body)));
  app.post('/api/v2/stories/:id/resources/enable',async request=>store.resources.enable(await story(request.params),resourceSetupSchema.parse(request.body)));
  app.get('/api/v2/stories/:id/npcs',async request=>store.npcs.publicState(await story(request.params)));
  app.post('/api/v2/stories/:id/facts/read',async request=>{const id=await story(request.params);const {ids}=z.object({ids:z.array(z.string().uuid()).max(50)}).strict().parse(request.body);return {facts:(await store.database.pool.query("SELECT id,text,kind,time FROM facts WHERE story_id=$1 AND id=ANY($2::uuid[]) AND visibility<>'private' ORDER BY seq",[id,ids])).rows};});
}
