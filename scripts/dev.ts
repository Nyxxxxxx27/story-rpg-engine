import { spawn } from 'node:child_process';
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const api = spawn(npm, ['run', 'api'], { stdio: 'inherit', windowsHide: true });
const web = spawn(npm, ['exec', 'vite'], { stdio: 'inherit', windowsHide: true });
const close = () => { api.kill(); web.kill(); };
process.on('SIGINT', close); process.on('SIGTERM', close);
await Promise.race([
  new Promise<void>(resolve => api.on('exit', () => resolve())),
  new Promise<void>(resolve => web.on('exit', () => resolve())),
]);
close();
