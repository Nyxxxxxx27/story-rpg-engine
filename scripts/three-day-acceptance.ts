import { createHash, randomInt } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { resolve } from 'node:path';
import { createServer as createVite, type ViteDevServer } from 'vite';
import { chromium, type Browser, type Page } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createStoryServer } from '../apps/api/server.ts';
import { containsPublicStoryLeak } from '../packages/agent-runtime/public-narration.ts';

const root = resolve('.'); const dataDirectory = resolve(`.data/acceptance-three-day-${Date.now()}`); const reportDirectory = resolve('reports/acceptance');
await mkdir(dataDirectory, { recursive: true }); await mkdir(reportDirectory, { recursive: true }); process.env.STORY_DATA_DIR = dataDirectory; process.env.STORY_SHUTDOWN_DIAGNOSTICS = '1';
const seed = randomInt(1, 2_147_483_647); const genres = ['cultivation', 'western_fantasy', 'science_fiction', 'modern_mystery'] as const; const genre = genres[seed % genres.length];
const packs = { cultivation: ['cultivation-hewan'], western_fantasy: ['western-fantasy'], science_fiction: ['generic-story'], modern_mystery: ['generic-story'] }[genre];
let service = await createStoryServer({ logger: false, directory: dataDirectory }); const apiAddress = await service.app.listen({ host: '127.0.0.1', port: 0 }); const apiPort = Number(new URL(apiAddress).port); let vite: ViteDevServer | undefined; let browser: Browser | undefined; let page: Page | undefined; let mcp: Client | undefined; let restarted = false; let restartDurationMs: number | null = null; let stageProposals = 0; let choicePauses = 0;
const startedAt = new Date().toISOString(); const pauseReasons: string[] = []; const notes: string[] = []; const pageErrors: string[] = [];
const request = async (path: string, init?: RequestInit) => new Promise<any>((resolveRequest, rejectRequest) => {
  const requestBody = typeof init?.body === 'string' ? init.body : undefined;
  const client = httpRequest(`${apiAddress}/api/v2${path}`, { method: init?.method ?? 'GET', headers: requestBody ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(requestBody) } : undefined }, response => {
    const chunks: Buffer[] = []; response.on('data', chunk => chunks.push(Buffer.from(chunk))); response.on('end', () => {
      try { const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); if ((response.statusCode ?? 500) >= 400) rejectRequest(new Error(`${path}: ${body.error ?? response.statusCode}`)); else resolveRequest(body); }
      catch (error) { rejectRequest(error); }
    });
  });
  client.setTimeout(900_000, () => client.destroy(new Error(`Local acceptance request timed out after 900000 ms: ${path}`)));
  client.on('error', rejectRequest); client.end(requestBody);
});
const post = (path: string, body?: unknown) => request(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });
const mcpResult = (value: any) => { const text = value.content?.find((item: any) => item.type === 'text')?.text; if (value.isError) throw new Error(text ?? 'MCP tool failed'); return value.structuredContent?.result ?? JSON.parse(text ?? 'null'); };
const connectMcp = async () => { const client = new Client({ name: 'three-day-acceptance', version: '1.0.0' }, { capabilities: {} }); const transport = new StdioClientTransport({ command: 'node', args: ['--import', 'tsx', 'apps/mcp/main.ts'], cwd: root, env: { ...process.env, STORY_API_URL: `${apiAddress}/api/v2` } as Record<string, string>, stderr: 'pipe' }); await client.connect(transport); return client; };
const waitTurn = async (storyId: string, turnId: string, timeoutMs = 900_000) => { const deadline = Date.now() + timeoutMs; let turn; do { turn = await request(`/stories/${storyId}/turns/${turnId}`); if (['completed', 'waiting_player', 'failed'].includes(turn.status)) return turn; await new Promise(resolvePromise => setTimeout(resolvePromise, 750)); } while (Date.now() < deadline); throw new Error(`Turn timed out: ${turnId}`); };
try {
  console.log(`[acceptance] seed=${seed} genre=${genre}`);
  const created = await post('/stories', { seed, config: { title: '三日验收故事', genre, premise: '让真实 Codex 根据题材建立一条以人物选择、长期谜团和可追溯后果为核心的故事。', tone: '沉浸、克制、人物关系清晰，避免无依据的突转', pacing: 'balanced', worldRules: ['所有重要变化必须由场景行动和已提交事实支撑', '主角重大选择留给玩家'], terminology: {}, contentBoundaries: ['不描写露骨性内容', '不以随机永久伤害制造廉价冲突'], storyPacks: packs, advancedPrompt: '长线主剧情优先于组织经营。每场让角色动机产生可追溯后果；不要泄漏其他题材的专用术语。', provider: 'codex', polishMode: 'standard' } }); const storyId = created.storyId as string;
  console.log('[acceptance] generating outline through real Codex Provider'); let outline = await post(`/stories/${storyId}/outline/generate`);
  outline = { ...outline, stages: outline.stages.map((stage: any, index: number) => index === 0 ? { ...stage, objective: `在故事首日完成：${stage.objective}`, entryCriteria: [...stage.entryCriteria, '玩家选择初始调查路线'], boundaries: [...stage.boundaries, '第一阶段结束时，是否公开已核实线索或继续保密由玩家决定'] } : stage) }; await request(`/stories/${storyId}/outline`, { method: 'PUT', body: JSON.stringify(outline) });
  vite = await createVite({ configFile: resolve('vite.config.ts'), server: { port: 4274, proxy: { '/api': apiAddress } } }); await vite.listen(); browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) }); page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }); page.on('pageerror', error => pageErrors.push(error.message)); await page.goto('http://127.0.0.1:4274');
  await page.evaluate(id => localStorage.setItem('story-id', id), storyId); await page.reload(); await page.getByText('长期主线', { exact: true }).waitFor({ timeout: 30_000 }); await page.screenshot({ path: resolve(reportDirectory, 'outline-review.png'), fullPage: true });
  await page.getByRole('button', { name: /确认大纲并开始/ }).click(); await page.getByText('故事尚未落笔', { exact: true }).waitFor({ timeout: 30_000 }); console.log(`[acceptance] outline confirmed in web: ${outline.stages.length} stages, ${outline.characters.length} characters`);
  mcp = await connectMcp(); const sent = mcpResult(await mcp.callTool({ name: 'story_send', arguments: { storyId, input: '我先与最可信的核心同行者核对眼前证据，再决定追查方向。', idempotencyKey: `acceptance-opening-${seed}` } })); const opening = mcpResult(await mcp.callTool({ name: 'story_wait', arguments: { storyId, turnId: sent.id, timeoutSeconds: 1200 } }, undefined, { timeout: 1_260_000 })); if (opening.status === 'failed') throw new Error(`Opening failed: ${opening.error}`); await page.locator('.scene-card h1').waitFor({ timeout: 30_000 }); console.log(`[acceptance] opening committed via MCP: ${opening.scene?.title}`);
  for (let attempt = 0; attempt < 12; attempt++) {
    const current = await request(`/stories/${storyId}`);
    if (current.status === 'finished') throw new Error('Story ended during opening; use the focused v2 smoke for this short outline.');
    if (current.activeStage?.awaitingDeadline) {
      await post(`/stories/${storyId}/stages/${current.activeStage.id}/deadline/resolve`, { revision: current.activeStage.revision, action: 'close', idempotencyKey: `opening-close-${current.activeStage.id}` }); continue;
    }
    const proposal = (await request(`/stories/${storyId}/stage-proposal`)).proposal;
    if (proposal) { stageProposals++; await post(`/stories/${storyId}/stage-proposal/${proposal.id}/review`, { decision: 'accept' }); continue; }
    if (!current.pendingDecision) break;
    choicePauses++; pauseReasons.push(current.pendingDecision.prompt);
    const resolution = await post(`/stories/${storyId}/choices/resolve`, { decisionId: current.pendingDecision.id, optionId: current.pendingDecision.options[0].id, idempotencyKey: `opening-choice-${current.pendingDecision.id}` });
    const consequence = await waitTurn(storyId, resolution.continuationTurnId); if (consequence.status === 'failed') throw new Error(consequence.error);
  }
  const beforeAutoplay = await request(`/stories/${storyId}`); const autoplayStart = beforeAutoplay.clock as number; await page.locator('.autoplay select').selectOption('4320'); await page.getByRole('button', { name: '开始托管' }).click();
  const deadline = Date.now() + 3 * 60 * 60 * 1000; let lastScenes = -1;
  while (Date.now() < deadline) {
    let state = await request(`/stories/${storyId}`); const session = state.autoplay;
    if (session?.scenes !== lastScenes) { lastScenes = session?.scenes ?? -1; console.log(`[acceptance] autoplay scenes=${lastScenes} clock=${state.clock} status=${session?.status}`); }
    if (state.latestTurn?.status === 'failed') throw new Error(`Turn failed: ${state.latestTurn.error}`);
    if (!restarted && (state.clock - autoplayStart >= 2160 || state.scenes.length >= 5)) {
      console.log('[acceptance] restarting API, worker, embedded PostgreSQL socket, and Codex Provider'); const restartStarted = Date.now(); await service.app.close(); service = await createStoryServer({ logger: false, directory: dataDirectory }); await service.app.listen({ host: '127.0.0.1', port: apiPort }); restartDurationMs = Date.now() - restartStarted; restarted = true; notes.push(`在世界时间 ${state.clock} 分钟、${state.scenes.length} 场处用 ${restartDurationMs} ms 完成服务与 Provider 重启，恢复后无重复场景。`); await new Promise(resolvePromise => setTimeout(resolvePromise, 1000)); state = await request(`/stories/${storyId}`);
    }
    if (session?.status === 'completed' || state.status === 'finished') break;
    if (session?.status === 'paused' && !['queued', 'assembling', 'directing', 'reviewing', 'repairing', 'committing', 'narrating', 'summarizing'].includes(state.latestTurn?.status)) {
      pauseReasons.push(session.pauseReason ?? 'unknown');
      if (state.activeStage?.awaitingDeadline) {
        await post(`/stories/${storyId}/stages/${state.activeStage.id}/deadline/resolve`, { revision: state.activeStage.revision, action: 'close', idempotencyKey: `acceptance-close-${state.activeStage.id}` });
      } else {
        const proposal = (await request(`/stories/${storyId}/stage-proposal`)).proposal;
        if (proposal) { stageProposals += 1; await post(`/stories/${storyId}/stage-proposal/${proposal.id}/review`, { decision: 'accept' }); }
        else if (state.pendingDecision) {
          choicePauses += 1;
          const result = mcpResult(await mcp!.callTool({ name: 'story_resolve_choice', arguments: { storyId, decisionId: state.pendingDecision.id, optionId: state.pendingDecision.options[0].id, idempotencyKey: `acceptance-choice-${state.pendingDecision.id}` } }));
          const consequence = await waitTurn(storyId, result.continuationTurnId); if (consequence.status === 'failed') throw new Error(consequence.error);
        }
        const after = await request(`/stories/${storyId}`);
        if (after.status !== 'finished' && !after.pendingDecision && !after.activeStage?.awaitingDeadline && !(await request(`/stories/${storyId}/stage-proposal`)).proposal) await post(`/stories/${storyId}/autoplay/resume`);
      }
    }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 1000));
  }
  const state = await request(`/stories/${storyId}`); const session = state.autoplay; if (session?.status !== 'completed') throw new Error(`Autoplay did not complete: ${session?.status}`);
  const allTurns = await service.database.pool.query('SELECT id,status,error FROM story_turns WHERE story_id=$1 ORDER BY created_at', [storyId]); const pending = allTurns.rows.filter(row => ['queued', 'assembling', 'directing', 'reviewing', 'repairing', 'committing', 'narrating', 'summarizing'].includes(row.status)); const failures = allTurns.rows.filter(row => row.status === 'failed');
  const allFacts = await service.database.pool.query('SELECT id,seq,source_turn_id,payload FROM facts WHERE story_id=$1 ORDER BY seq', [storyId]); const allScenes = await service.database.pool.query('SELECT data FROM scenes WHERE story_id=$1 ORDER BY seq', [storyId]); const polishSteps = await service.database.pool.query("SELECT DISTINCT s.turn_id FROM turn_steps s JOIN story_turns t ON t.id=s.turn_id WHERE t.story_id=$1 AND s.agent_role='Polish Agent' AND s.status='completed'", [storyId]); const hashes = await service.store.stateHashes(storyId);
  const sceneIds = allScenes.rows.map(row => row.data.id); const factIds = allFacts.rows.map(row => row.id); const heroine = state.characters.find((character: any) => character.roleTags.includes('heroine') || character.roleTags.includes('love_interest')); const heroineScenes = heroine ? allScenes.rows.filter(row => row.data.participants.includes(heroine.id)).length : 0;
  const forbidden = genre === 'cultivation' ? [] : ['宗门', '灵力', '境界', '修炼']; const leaked = forbidden.filter(term => JSON.stringify({ outline, scenes: allScenes.rows.map(row => row.data) }).includes(term));
  const publicNarrationClean = allScenes.rows.every(row => ![row.data.title, row.data.prose, row.data.summary, ...(row.data.choices ?? [])].some((text: string) => containsPublicStoryLeak(text)));
  const assertions = {
    targetOrEnding: state.clock === autoplayStart + 4320 || state.status === 'finished', atLeastTwoScenes: allScenes.rows.length >= 2, stageProposalReviewed: stageProposals >= 1,
    heroineParticipatedTwice: heroineScenes >= 2, noPending: pending.length === 0, noFailures: failures.length === 0,
    noDuplicateScenes: new Set(sceneIds).size === sceneIds.length, noDuplicateFacts: new Set(factIds).size === factIds.length,
    everyFactTraceable: allFacts.rows.every(row => row.source_turn_id && row.payload), noGenreLeak: leaked.length === 0, replayHashMatches: hashes.matches,
    restarted, boundedRestart: restartDurationMs !== null && restartDurationMs <= 30_000, noUnhandledBrowserErrors: pageErrors.length === 0, mcpAndWebSameProtocol: opening.source === 'codex' && state.scenes.some((scene: any) => scene.turnId === opening.id),
    choicePauseObserved: choicePauses >= 1, publicNarrationClean, polishStepPerScene: polishSteps.rows.length === allScenes.rows.length,
  };
  const failed = Object.entries(assertions).filter(([, value]) => !value); if (failed.length) throw new Error(`Acceptance assertions failed: ${failed.map(([name]) => name).join(', ')}`);
  await page.reload(); await page.locator('.scene-card h1').waitFor({ timeout: 30_000 }); const visibleProse = await page.locator('.scene-card .prose').innerText(); if (containsPublicStoryLeak(visibleProse)) throw new Error('Visible story prose contains private or engine meta-language.'); await page.screenshot({ path: resolve(reportDirectory, 'three-day-final.png'), fullPage: true });
  const promptRevision = await service.database.pool.query('SELECT prompt_version FROM stories WHERE id=$1', [storyId]); const report = { version: 'story-v2', startedAt, completedAt: new Date().toISOString(), seed, genre, storyId, title: state.title, provider: 'codex-app-server', model: process.env.CODEX_MODEL ?? 'gpt-5.6-luna', promptVersion: Number(promptRevision.rows[0].prompt_version), polishMode: state.config.polishMode, polishSteps: polishSteps.rows.length, autoplayStart, autoplayTarget: autoplayStart + 4320, finalClock: state.clock, autoplayScenes: session.scenes, totalScenes: allScenes.rows.length, factCount: allFacts.rows.length, stageProposalsReviewed: stageProposals, choicePauses, pauseReasons, heroine: heroine?.name, heroineScenes, restarted, restartDurationMs, hashes, assertions, notes, finalStateDigest: createHash('sha256').update(JSON.stringify(state)).digest('hex') };
  await writeFile(resolve(reportDirectory, 'three-day-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await writeFile(resolve(reportDirectory, 'THREE_DAY_ACCEPTANCE.md'), `# 三天剧情验收\n\n- 结果：**PASS**\n- 随机种子：\`${seed}\`\n- 题材：\`${genre}\`\n- Provider：Codex App Server（\`${report.model}\`，只读沙箱，结构化输出）\n- Prompt 版本：\`${report.promptVersion}\`\n- 正式输出前润色：\`${state.config.polishMode}\`，${polishSteps.rows.length} 个场景完成 Polish Agent\n- 世界时间：\`${autoplayStart}\` → \`${state.clock}\`，以 **4320 分钟或最终结局** 为停止条件\n- 场景：托管 ${session.scenes}，总计 ${allScenes.rows.length}\n- 规范事实：${allFacts.rows.length}\n- 阶段提案审核：${stageProposals}\n- 关键选择暂停：${choicePauses}\n- 核心角色：${heroine?.name ?? '未找到'}，参与 ${heroineScenes} 场\n- 中途重启恢复：${restarted ? `通过（${restartDurationMs} ms）` : '未执行'}\n- 浏览器未处理异常：无\n- 状态哈希：\`${hashes.stateHash}\`\n- 重放哈希：\`${hashes.replayHash}\`\n- 公开正文元话语泄漏：无\n- 跨题材术语泄漏：无\n- Codex MCP 与网页协议一致：通过\n\n截图：\`outline-review.png\`、\`three-day-final.png\`。完整机器可读结果见 \`three-day-report.json\`。\n`, 'utf8');
  console.log(`[acceptance] PASS story=${storyId} scenes=${allScenes.rows.length} hash=${hashes.stateHash}`);
} finally {
  await mcp?.close().catch(() => undefined); await browser?.close().catch(() => undefined); await vite?.close().catch(() => undefined); await service.app.close().catch(() => undefined);
}
process.exit(0);
