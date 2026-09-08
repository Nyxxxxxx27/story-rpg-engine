import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import pg from 'pg';
import { PgBoss } from 'pg-boss';

export async function connectDatabase(options: { url?: string; directory?: string; port?: number } = {}) {
  let embedded: PGlite | undefined;
  let socket: PGLiteSocketServer | undefined;
  // An explicit directory always selects an isolated embedded store, including in tests.
  let url = options.url ?? (options.directory ? undefined : process.env.DATABASE_URL);
  if (!url) {
    const directory = options.directory ?? process.env.STORY_DATA_DIR ?? resolve('.data/story-postgres');
    if (directory !== 'memory://') await mkdir(directory, { recursive: true });
    embedded = await PGlite.create(directory);
    socket = new PGLiteSocketServer({ db: embedded, host: '127.0.0.1', port: options.port ?? 0, maxConnections: 20 });
    await socket.start();
    const address = socket.getServerConn();
    url = address.startsWith('postgres') ? address : `postgresql://postgres:postgres@${address}/postgres`;
  }
  const pool = new pg.Pool({ connectionString: url, max: embedded ? 1 : 10, connectionTimeoutMillis: 8000 });
  const boss = new PgBoss({ db: { executeSql: (text, values) => pool.query(text, values) }, schema: 'story_jobs', backend: embedded ? 'pglite' : 'postgres', schedule: false });
  boss.on('error', error => console.error('Story queue:', error.message));
  await boss.start();
  await boss.createQueue('story-turn', { retryLimit: 2, retryDelay: 2, expireInSeconds: 3600 });
  const close = async () => {
    await boss.stop({ close: false, graceful: false, timeout: 1000 });
    await pool.end();
    if (socket) await socket.stop();
    if (embedded) await embedded.close();
  };
  const backupRoot = options.directory ?? process.env.STORY_DATA_DIR ?? '.data';
  return { pool, boss, embedded: !!embedded, backupDirectory: resolve(backupRoot === 'memory://' ? '.data' : backupRoot, 'migration-backups'), close };
}
export type Database = Awaited<ReturnType<typeof connectDatabase>>;
