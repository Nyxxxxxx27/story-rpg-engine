import { build } from 'esbuild';
await build({ entryPoints: ['apps/api/main.ts', 'apps/worker/main.ts', 'apps/mcp/main.ts'], outbase: 'apps', outdir: 'dist/server', bundle: true, packages: 'external', platform: 'node', format: 'esm', target: 'node24', sourcemap: true });
