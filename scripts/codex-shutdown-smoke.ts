import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createStoryServer } from '../apps/api/server.ts';

const directory = resolve('.data/codex-shutdown-smoke'); await rm(directory, { recursive: true, force: true }); process.env.STORY_DATA_DIR = directory; process.env.STORY_SHUTDOWN_DIAGNOSTICS = '1';
const service = await createStoryServer({ logger: false, directory }); let reopened: Awaited<ReturnType<typeof createStoryServer>> | undefined; let closed = false; const sseController = new AbortController();
try {
  await service.app.listen({ host: '127.0.0.1', port: 4311 });
  const config = { title: '关闭恢复烟雾测试', genre: 'science_fiction' as const, premise: '一次中断恢复测试。', tone: '克制', pacing: 'balanced' as const, worldRules: ['事实必须可追溯'], terminology: {}, contentBoundaries: [], storyPacks: ['generic-story'], advancedPrompt: '', provider: 'deterministic' as const, polishMode: 'standard' as const, romanceMode: 'organic' as const, fastReview: false, rulesAtStart: false };
  const created = await service.store.create('local-player', config, 20260901); await service.runtime.generateOutline(created.storyId, 'local-player'); await service.store.confirmOutline(created.storyId, 'local-player'); await service.store.updateConfig(created.storyId, 'local-player', { ...config, provider: 'codex' }); const sse = await fetch(`http://127.0.0.1:4311/api/v2/stories/${created.storyId}/events`, { signal: sseController.signal }); if (!sse.ok) throw new Error(`SSE failed: ${sse.status} ${await sse.text()}`);
  const turn = await service.store.enqueueTurn(created.storyId, '启动一个真实 Codex 场景，然后立即模拟服务重启。', 'test', 'codex-shutdown-smoke'); await service.store.flushOutbox();
  const deadline = Date.now() + 180_000; let status = 'queued';
  while (Date.now() < deadline) { status = (await service.store.turn(turn.id)).status; if (status === 'reviewing') break; await new Promise(resolveWait => setTimeout(resolveWait, 50)); }
  if (status !== 'reviewing') throw new Error(`Real Codex review fan-out did not start: ${status}`);
  const started = Date.now(); await service.app.close(); closed = true; const elapsed = Date.now() - started; console.log(`codex-active-shutdown-ms=${elapsed} interrupted-status=${status}`); if (elapsed > 10_000) throw new Error(`Shutdown exceeded 10 seconds: ${elapsed}`);
  const reopenStarted = Date.now(); reopened = await createStoryServer({ logger: false, directory }); await reopened.app.listen({ host: '127.0.0.1', port: 4311 }); const recovered = await reopened.store.turn(turn.id); const reopenElapsed = Date.now() - reopenStarted; console.log(`codex-reopen-ms=${reopenElapsed} recovered-status=${recovered.status}`); if (reopenElapsed > 10_000) throw new Error(`Reopen exceeded 10 seconds: ${reopenElapsed}`); await reopened.app.close(); reopened = undefined;
} finally {
  sseController.abort();
  await reopened?.app.close().catch(() => undefined);
  if (!closed) await service.app.close().catch(() => undefined);
  await rm(directory, { recursive: true, force: true });
}
