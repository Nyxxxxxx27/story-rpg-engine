import { expect, test } from '@playwright/test';
test.afterAll(async ({ request }) => { await request.post('http://127.0.0.1:4310/__test/stop').catch(() => undefined); });
test('creates a story, confirms the outline, runs a turn, and shows Agent results', async ({ page }) => {
  const pageErrors: string[] = []; page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto('/'); await page.getByLabel('Agent Provider').selectOption('deterministic'); await page.getByRole('button', { name: '创建故事草稿' }).click();
  await expect(page.getByText('开局向导')).toBeVisible(); await page.getByRole('button', { name: '随机生成大纲' }).click(); await expect(page.getByText('长期主线')).toBeVisible();
  await page.route(/\/api\/v2\/stories\/[^/]+\/stage-proposal$/, route => route.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({ error: 'test restart window' }) }), { times: 1 });
  await page.getByRole('button', { name: /确认大纲并开始/ }).click(); await expect(page.getByText('故事尚未落笔')).toBeVisible();
  await page.getByPlaceholder('描述主角的行动、回应或想调查的方向…').fill('与核心同行者核对第一条线索。'); await page.locator('.send').click();
  await expect(page.locator('.scene-card h1')).toBeVisible({ timeout: 30_000 }); await page.getByRole('button', { name: 'Agent' }).click();
  await expect(page.getByText('Transaction Committer')).toBeVisible(); await expect(page.getByText('Narrator Agent')).toBeVisible(); expect(pageErrors).toEqual([]);
});
