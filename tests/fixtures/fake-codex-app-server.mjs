import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

if (process.env.STORY_FAKE_CODEX_MARKER) appendFileSync(process.env.STORY_FAKE_CODEX_MARKER, 'started\n');
const lines = createInterface({ input: process.stdin });
let sequence = 0;
const send = message => process.stdout.write(`${JSON.stringify(message)}\n`);

lines.on('line', line => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') return send({ id: message.id, result: { userAgent: 'fake' } });
  if (message.method === 'thread/start') return send({ id: message.id, result: { thread: { id: `thread-${++sequence}` } } });
  if (message.method === 'turn/start') {
    const turnId = `turn-${++sequence}`; send({ id: message.id, result: { turn: { id: turnId } } });
    setTimeout(() => {
      send({ method: 'item/completed', params: { turnId, item: { type: 'agentMessage', text: JSON.stringify({ value: turnId }) } } });
      send({ method: 'turn/completed', params: { turn: { id: turnId, status: 'completed' } } });
    }, 10);
    return;
  }
  if (message.method === 'turn/interrupt') return send({ id: message.id, result: {} });
});
