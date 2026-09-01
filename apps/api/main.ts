import { createStoryServer } from './server.ts';

const port = Number(process.env.PORT ?? 4310); const host = process.env.HOST ?? '127.0.0.1';
const { app } = await createStoryServer();
await app.listen({ port, host });
console.log(`Story RPG API listening at http://${host}:${port}`);
