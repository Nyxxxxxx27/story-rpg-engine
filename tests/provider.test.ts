import { afterEach, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { CodexAppServerModel } from '../packages/agent-runtime/provider.ts';

const cleanups: Array<() => Promise<void>> = []; afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

it('initializes one persistent Codex App Server connection for concurrent ephemeral turns', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'story-codex-provider-')); const marker = join(directory, 'starts.txt'); const previous = process.env.STORY_FAKE_CODEX_MARKER; process.env.STORY_FAKE_CODEX_MARKER = marker;
  const model = new CodexAppServerModel({ command: process.execPath, args: [resolve('tests/fixtures/fake-codex-app-server.mjs')], cwd: directory, timeoutMs: 5_000 });
  cleanups.push(async () => { await model.close(); if (previous === undefined) delete process.env.STORY_FAKE_CODEX_MARKER; else process.env.STORY_FAKE_CODEX_MARKER = previous; await rm(directory, { recursive: true, force: true }); });
  const schema = { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false };
  const results = await Promise.all([model.generate('first', schema), model.generate('second', schema)]); expect(results.every(result => JSON.parse(result).value.startsWith('turn-'))).toBe(true);
  expect((await readFile(marker, 'utf8')).trim().split(/\r?\n/)).toHaveLength(1);
});
