import { z } from 'zod';
import { codexProvider } from '../packages/agent-runtime/provider.ts';
const schema = z.object({ ok: z.literal(true), provider: z.literal('codex-app-server') }).strict();
const result = await codexProvider({ timeoutMs: 120_000 }).run('Provider Smoke Agent', 'Return the required JSON. Do not use tools.', schema);
console.log(JSON.stringify(result));
