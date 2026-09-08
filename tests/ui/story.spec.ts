import { expect, test } from '@playwright/test';
import { testConfig } from '../helpers.ts';
test.afterAll(async ({ request }) => { await request.post('/api/v2/__test/stop').catch(() => undefined); });
test('creates a story, confirms the outline, runs a turn, and shows Agent results', async ({ page }) => {
  const pageErrors: string[] = []; page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto('/'); await page.getByLabel('Agent Provider').selectOption('deterministic'); await page.getByRole('button', { name: '创建故事草稿' }).click();
  await expect(page.getByText('开局向导')).toBeVisible(); await page.getByRole('button', { name: '随机生成大纲' }).click(); await expect(page.getByText('长期主线')).toBeVisible();
  await page.route(/\/api\/v2\/stories\/[^/]+\/stage-proposal$/, route => route.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({ error: 'test restart window' }) }), { times: 1 });
  await page.getByRole('button', { name: /确认大纲并开始/ }).click(); await expect(page.getByText('故事尚未落笔')).toBeVisible();
  await page.getByPlaceholder('描述主角的行动、回应或想调查的方向…').fill('与核心同行者核对第一条线索。'); await page.locator('.send').click();
  await expect(page.locator('.scene-card h1')).toBeVisible({ timeout: 30_000 }); const prose = await page.locator('.scene-card .prose').innerText(); expect(prose).not.toMatch(/玩家|用户|候选场景|已提交事实|结构化输出|状态变更|长期目标|阶段目标|思维链|<thinking>/);
  await expect(page.locator('.choice-list button').first()).toBeEnabled(); await page.locator('.choice-list button').first().click();
  await expect(page.getByRole('button', { name: '确认进入' })).toBeVisible();
  await page.getByRole('button', { name: 'Agent' }).click();
  await expect(page.getByText('Transaction Committer')).toBeVisible(); await expect(page.getByText('Narrator Agent')).toBeVisible(); await expect(page.getByText('Polish Agent')).toBeVisible(); expect(pageErrors).toEqual([]);
});

test('a critical choice runs one scene and leaves autoplay paused until explicit resume', async ({ page, request }) => {
  const created = await (await request.post('/api/v2/stories', { data: { config: testConfig(), seed: 20260906 } })).json(); const id = created.storyId;
  const outline = await (await request.post(`/api/v2/stories/${id}/outline/generate`)).json(); outline.stages[0].entryCriteria = ['玩家选择调查路线'];
  await request.post(`/api/v2/stories/${id}/outline/confirm`, { data: outline });
  await page.goto('/'); await page.evaluate(id => localStorage.setItem('story-id', id), id); await page.reload();
  await page.getByLabel('托管时长').selectOption('1440'); await page.getByRole('button', { name: '开始托管' }).click();
  const state = async () => (await request.get(`/api/v2/stories/${id}`)).json();
  await expect.poll(async () => (await state()).pendingDecision?.status).toBe('pending');
  await expect(page.locator('.choice-list button').first()).toBeEnabled();
  const decision = (await state()).pendingDecision;
  await page.locator('.choice-list button').first().click();
  await expect.poll(async () => (await state()).scenes.length).toBe(2);
  await expect(page.getByRole('button', { name: '继续托管' })).toBeEnabled();
  const after = await state(); expect(after.autoplay.status).toBe('paused'); expect(after.latestTurn.decisionId).toBe(decision.id); expect(after.latestTurn.status).toBe('completed');
  await page.reload(); await expect(page.getByRole('button', { name: '继续托管' })).toBeEnabled();
  expect((await state()).scenes.length).toBe(2);
  await page.getByRole('button', { name: '继续托管' }).click();
  await expect.poll(async () => (await state()).scenes.length).toBe(3);
  await expect(page.getByRole('button', { name: '确认进入' })).toBeVisible();
});

test('deadline controls preserve partial progress and do not resume autoplay', async ({ page, request }) => {
  const created = await (await request.post('/api/v2/stories', { data: { config: testConfig(), seed: 20260906 } })).json(); const id = created.storyId;
  const outline = await (await request.post(`/api/v2/stories/${id}/outline/generate`)).json(); outline.stages[0].deadlineMinutes = 120;
  await request.post(`/api/v2/stories/${id}/outline/confirm`, { data: outline });
  await page.goto('/'); await page.evaluate(id => localStorage.setItem('story-id', id), id); await page.reload();
  await page.getByRole('button', { name: '开始托管' }).click();
  await expect(page.getByRole('heading', { name: '阶段期限已到' })).toBeVisible();
  await expect(page.getByRole('button', { name: '发送行动' })).toBeDisabled();
  await page.getByRole('button', { name: '按当前成果结束' }).click();
  await expect(page.getByRole('button', { name: '确认进入' })).toBeVisible();
  const state = await (await request.get(`/api/v2/stories/${id}`)).json(); expect(state.activeStage.progress).toBe(50); expect(state.activeStage.outcome).toBe('partial'); expect(state.autoplay.status).toBe('paused');
  await page.getByRole('button', { name: '确认进入' }).click(); await expect(page.getByRole('button', { name: '继续托管' })).toBeEnabled();
});

test('enables resources, executes one priced action, reads evidence and restores an independent save',async({page,request})=>{
  const created=await(await request.post('/api/v2/stories',{data:{config:testConfig(),seed:15}})).json(),id=created.storyId;
  await request.post(`/api/v2/stories/${id}/outline/generate`);await request.post(`/api/v2/stories/${id}/outline/confirm`);
  await page.goto('/');await page.evaluate(id=>localStorage.setItem('story-id',id),id);await page.reload();await page.getByRole('button',{name:'角色面板',exact:true}).click();
  await expect(page.getByRole('button',{name:'确认面板并启用规则'})).toBeVisible();await page.getByRole('button',{name:'确认面板并启用规则'}).click();
  await expect(page.getByRole('button',{name:'查看代价'})).toBeVisible();await page.getByRole('button',{name:'查看代价'}).click();await expect(page.getByText(/体力 5，金钱 0，15 故事分钟/)).toBeVisible();await page.getByRole('button',{name:'执行这一行动'}).click();
  const state=async()=>await(await request.get(`/api/v2/stories/${id}`)).json();await expect.poll(async()=>(await state()).latestTurn?.status).toBe('completed');
  await page.getByRole('button',{name:'故事',exact:true}).click();await page.locator('.event-evidence summary').click();await expect(page.locator('.event-evidence p').first()).toBeVisible();
  await page.getByRole('button',{name:'历史与记忆'}).click();await expect(page.getByRole('heading',{name:'历史阅读',exact:true})).toBeVisible();await expect(page.locator('.history-scene h2')).toHaveCount(1);
  await page.getByRole('button',{name:'存档与分叉'}).click();const download=page.waitForEvent('download');await page.getByRole('button',{name:'导出最新检查点'}).click();expect((await download).suggestedFilename()).toContain('.srpg.json');
  const archive=await(await request.get(`/api/v2/stories/${id}/save`)).json();await page.getByLabel('恢复存档').setInputFiles({name:'restore.srpg.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(archive))});
  await expect.poll(async()=>page.evaluate(()=>localStorage.getItem('story-id'))).not.toBe(id);const restoredId=await page.evaluate(()=>localStorage.getItem('story-id'));const restored=await(await request.get(`/api/v2/stories/${restoredId}`)).json();expect(restored.scenes[0].prose).toBe((await state()).scenes[0].prose);expect(restored.clock).toBe(15);
  await page.getByRole('button',{name:'历史与记忆'}).click();await page.getByRole('button',{name:'历史阅读',exact:true}).click();
  await page.getByRole('button',{name:'从这一场分叉'}).first().click();
  await expect.poll(async()=>page.evaluate(()=>localStorage.getItem('story-id'))).not.toBe(restoredId);const forkId=await page.evaluate(()=>localStorage.getItem('story-id'));
  expect(forkId).not.toBe(id);const fork=await(await request.get(`/api/v2/stories/${forkId}`)).json();expect(fork.clock).toBe(15);expect(fork.scenes).toHaveLength(1);expect((await state()).scenes).toHaveLength(1);
});
