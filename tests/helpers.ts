import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { connectDatabase } from '../packages/storage/database.ts';
import { StoryStore } from '../packages/storage/store.ts';
import { StoryRuntime } from '../packages/agent-runtime/runtime.ts';
import { deterministicProvider } from '../packages/agent-runtime/provider.ts';
import { storyDeterministicGenerator } from '../packages/agent-runtime/deterministic.ts';

export const testConfig = (genre: 'cultivation' | 'western_fantasy' | 'science_fiction' | 'modern_mystery' | 'custom' = 'science_fiction') => ({
  title: '验收故事', genre, premise: '一次需要长期追查的异常事件。', tone: '克制且重视人物选择', pacing: 'balanced' as const,
  worldRules: ['结果必须有证据'], terminology: {}, contentBoundaries: [], storyPacks: [genre === 'cultivation' ? 'cultivation-hewan' : genre === 'western_fantasy' ? 'western-fantasy' : 'generic-story'], advancedPrompt: '', provider: 'deterministic' as const,
});

export async function fixture() {
  const directory = resolve(`.data/test-${randomUUID()}`); const database = await connectDatabase({ directory }); const store = new StoryStore(database); await store.setup();
  const runtime = new StoryRuntime(store, () => deterministicProvider(storyDeterministicGenerator));
  return { directory, database, store, runtime, async close() { await database.close(); await rm(directory, { recursive: true, force: true }); } };
}

export async function createActiveStory(value: Awaited<ReturnType<typeof fixture>>, genre: Parameters<typeof testConfig>[0] = 'science_fiction') {
  const created = await value.store.create('test', testConfig(genre), 20260901); await value.runtime.generateOutline(created.storyId, 'test'); await value.store.confirmOutline(created.storyId, 'test'); return created.storyId;
}
