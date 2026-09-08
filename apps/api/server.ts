import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { z } from 'zod';
import { connectDatabase, type Database } from '../../packages/storage/database.ts';
import { StoryStore } from '../../packages/storage/store.ts';
import { StoryRuntime } from '../../packages/agent-runtime/runtime.ts';
import { codexProvider, deterministicProvider, openAiProvider, type StructuredAgentProvider } from '../../packages/agent-runtime/provider.ts';
import { storyDeterministicGenerator } from '../../packages/agent-runtime/deterministic.ts';
import { createStoryRequestSchema, createTurnRequestSchema, outlineDraftSchema, storyStageSchema, storyWorldConfigSchema, resolveChoiceRequestSchema, deadlineRequestSchema } from '../../packages/contracts/index.ts';
import { StoryConflict } from '../../packages/storage/errors.ts';
import { experienceRoutes } from './experience-routes.ts';

const owner = 'local-player';
const idParams = z.object({ id: z.string().uuid() });
const storyTurnParams = z.object({ id: z.string().uuid(), turnId: z.string().uuid() });

export async function createStoryServer(options: { database?: Database; directory?: string; startWorker?: boolean; logger?: boolean } = {}) {
  const database = options.database ?? await connectDatabase({ directory: options.directory }); const ownsDatabase = !options.database;
  const store = new StoryStore(database); await store.setup();
  const providers = new Map<string, StructuredAgentProvider>();
  const resolver = (config: { provider: string }) => {
    let provider = providers.get(config.provider); if (provider) return provider;
    if (config.provider === 'codex') provider = codexProvider();
    else if (config.provider === 'openai') provider = openAiProvider();
    else provider = deterministicProvider(storyDeterministicGenerator);
    providers.set(config.provider, provider); return provider;
  };
  const runtime = new StoryRuntime(store, resolver); if (options.startWorker !== false) await runtime.start();
  const app = Fastify({ logger: options.logger ?? true, bodyLimit: 1_000_000, forceCloseConnections: true });
  await app.register(rateLimit, { max: 2_000, timeWindow: '1 minute' });

  app.setErrorHandler((error, _request, reply) => {
    const failure = error instanceof Error ? error : new Error(String(error));
    const status = failure instanceof StoryConflict ? 409 : failure.message.includes('NOT_FOUND') ? 404 : failure.message.includes('UNAUTHORIZED') ? 403 : failure.name === 'ZodError' ? 400 : 500;
    reply.status(status).send({ error: failure.message, code: failure instanceof StoryConflict ? failure.code : status === 500 ? 'INTERNAL_ERROR' : 'INVALID_REQUEST' });
  });
  app.get('/api/v2/health', async () => ({ ok: true, version: 'story-v2', provider: 'explicit-per-story' }));
  experienceRoutes(app, store, runtime, owner);
  app.get('/api/v2/stories', async () => ({ stories: await store.list(owner) }));
  app.post('/api/v2/stories', async request => store.create(owner, createStoryRequestSchema.parse(request.body).config, createStoryRequestSchema.parse(request.body).seed));
  app.get('/api/v2/stories/:id', async request => store.state(idParams.parse(request.params).id, owner));
  app.put('/api/v2/stories/:id/config', async request => store.updateConfig(idParams.parse(request.params).id, owner, storyWorldConfigSchema.parse(request.body)));
  app.post('/api/v2/stories/:id/outline/generate', async request => runtime.generateOutline(idParams.parse(request.params).id, owner));
  app.put('/api/v2/stories/:id/outline', async request => store.saveOutline(idParams.parse(request.params).id, owner, outlineDraftSchema.parse(request.body)));
  app.post('/api/v2/stories/:id/outline/confirm', async request => store.confirmOutline(idParams.parse(request.params).id, owner, request.body ? outlineDraftSchema.parse(request.body) : undefined));
  app.post('/api/v2/stories/:id/turns', async request => {
    const storyId = idParams.parse(request.params).id; await store.state(storyId, owner); const body = createTurnRequestSchema.parse(request.body);
    const turn = await store.enqueueTurn(storyId, body.input, body.source, body.idempotencyKey, body); await store.flushOutbox(); return turn;
  });
  app.post('/api/v2/stories/:id/choices/resolve', async request => { const storyId = idParams.parse(request.params).id; await store.state(storyId, owner); const result = await store.resolveChoice(storyId, resolveChoiceRequestSchema.parse(request.body)); await store.flushOutbox(); return result; });
  app.get('/api/v2/stories/:id/turns/:turnId', async request => {
    const params = storyTurnParams.parse(request.params); await store.state(params.id, owner); const turn = await store.turn(params.turnId); if (turn.storyId !== params.id) throw new Error('TURN_NOT_FOUND'); return turn;
  });
  const retryBody = z.object({ idempotencyKey: z.string().min(8).max(120) }).strict();
  app.post('/api/v2/stories/:id/turns/:turnId/retry', async request => {
    const params = storyTurnParams.parse(request.params); await store.state(params.id, owner); const body = retryBody.parse(request.body);
    const result = await store.retryTurn(params.id, params.turnId, body.idempotencyKey); await store.flushOutbox(); return result;
  });
  app.post('/api/v2/stories/:id/scenes/:sceneId/narration/retry', async request => {
    const params = z.object({ id: z.string().uuid(), sceneId: z.string().uuid() }).parse(request.params); await store.state(params.id, owner); const body = retryBody.parse(request.body);
    const result = await store.retrySceneNarration(params.id, params.sceneId, body.idempotencyKey); await store.flushOutbox(); return result;
  });
  app.post('/api/v2/stories/:id/stages/:stageId/deadline/resolve', async request => {
    const params = z.object({ id: z.string().uuid(), stageId: z.string().uuid() }).parse(request.params); await store.state(params.id, owner);
    const result = await store.resolveDeadline(params.id, params.stageId, deadlineRequestSchema.parse(request.body)); await store.flushOutbox(); return result;
  });
  app.get('/api/v2/stories/:id/metrics', async request => { const storyId = idParams.parse(request.params).id; await store.state(storyId, owner); return store.metrics(storyId); });
  app.put('/api/v2/stories/:id/stages/:stageId', async request => {
    const params = z.object({ id: z.string().uuid(), stageId: z.string().uuid() }).parse(request.params); await store.state(params.id, owner);
    const stage = storyStageSchema.parse(request.body); if (stage.id !== params.stageId) throw new Error('STAGE_ID_MISMATCH'); return store.editStage(params.id, stage);
  });
  app.get('/api/v2/stories/:id/stage-proposal', async request => { const storyId = idParams.parse(request.params).id; await store.state(storyId, owner); const proposals=await store.pendingProposals(storyId); return { proposal: proposals.length===1?proposals[0]:null,proposals }; });
  app.post('/api/v2/stories/:id/stage-proposal/:proposalId/review', async request => {
    const params = z.object({ id: z.string().uuid(), proposalId: z.string().uuid() }).parse(request.params); await store.state(params.id, owner);
    const { decision } = z.object({ decision: z.enum(['accept', 'reject']) }).parse(request.body); return runtime.reviewStageProposal(params.id, params.proposalId, decision);
  });
  app.post('/api/v2/stories/:id/autoplay', async request => { const storyId = idParams.parse(request.params).id; await store.state(storyId, owner); return runtime.startAutoplay(storyId, request.body); });
  app.get('/api/v2/stories/:id/autoplay', async request => { const storyId = idParams.parse(request.params).id; await store.state(storyId, owner); return { autoplay: await store.autoplay(storyId) }; });
  app.post('/api/v2/stories/:id/autoplay/resume', async request => { const storyId = idParams.parse(request.params).id; await store.state(storyId, owner); return runtime.resumeAutoplay(storyId); });
  app.delete('/api/v2/stories/:id/autoplay', async request => { const storyId = idParams.parse(request.params).id; await store.state(storyId, owner); return store.stopAutoplay(storyId); });
  app.get('/api/v2/stories/:id/events', async (request, reply) => {
    const storyId = idParams.parse(request.params).id; await store.state(storyId, owner); reply.hijack();
    reply.raw.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'access-control-allow-origin': '*' });
    let signature = ''; let emitting = false; let closed = false;
    const emit = async () => {
      if (emitting || closed) return; emitting = true;
      try { const state = await store.state(storyId, owner); const next = `${state.revision}:${state.latestTurn?.updatedAt ?? 0}:${state.autoplay?.status ?? ''}:${state.autoplay?.scenes ?? 0}`; if (next !== signature) { signature = next; reply.raw.write(`event: state\ndata: ${JSON.stringify(state)}\n\n`); } }
      catch { reply.raw.end(); }
      finally { emitting = false; }
    };
    await emit(); const timer = setInterval(() => void emit(), 500); request.raw.on('close', () => { closed = true; clearInterval(timer); });
  });

  app.addHook('onClose', async () => {
    const diagnostics = process.env.STORY_SHUTDOWN_DIAGNOSTICS === '1'; let phaseStarted = Date.now();
    if (options.startWorker !== false) { await runtime.stop(); if (diagnostics) console.log(`[shutdown] runtime=${Date.now() - phaseStarted}ms`); }
    phaseStarted = Date.now(); await Promise.allSettled([...providers.values()].map(provider => provider.close?.())); if (diagnostics) console.log(`[shutdown] providers=${Date.now() - phaseStarted}ms`);
    if (ownsDatabase) { phaseStarted = Date.now(); await database.close(); if (diagnostics) console.log(`[shutdown] database=${Date.now() - phaseStarted}ms`); }
  });
  return { app, database, store, runtime };
}
