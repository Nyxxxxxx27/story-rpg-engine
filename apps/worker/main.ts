import { connectDatabase } from '../../packages/storage/database.ts';
import { StoryStore } from '../../packages/storage/store.ts';
import { StoryRuntime } from '../../packages/agent-runtime/runtime.ts';
import { codexProvider, deterministicProvider, openAiProvider } from '../../packages/agent-runtime/provider.ts';
import { storyDeterministicGenerator } from '../../packages/agent-runtime/deterministic.ts';

const database = await connectDatabase(); const store = new StoryStore(database); await store.setup();
const runtime = new StoryRuntime(store, config => config.provider === 'codex' ? codexProvider() : config.provider === 'openai' ? openAiProvider() : deterministicProvider(storyDeterministicGenerator));
await runtime.start(); console.log('Story RPG worker is running.');
const close = async () => { await runtime.stop(); await database.close(); process.exit(0); };
process.on('SIGINT', close); process.on('SIGTERM', close);
