import { expect, test } from '@playwright/test';

test('notification pages require a session', async ({ page }) => {
  for (const path of ['/ru/app/notifications', '/ru/app/notifications/settings', '/en/app/notifications/settings']) {
    await page.goto(path);
    await expect(page, path).toHaveURL(/\/(ru|en)\/login\?next=/);
    await expect(page.locator('input[name="next"]'), path).toHaveValue(path);
  }
});

test('scheduled jobs and the bot webhook refuse calls without their secrets', async ({ request }) => {
  expect((await request.get('/api/cron/notifications')).status()).toBe(401);
  expect((await request.get('/api/cron/notifications', { headers: { authorization: 'Bearer wrong' } })).status()).toBe(401);
  const update = { message: { chat: { id: 1 }, text: '/start 0A1B2C3D4E' } };
  expect((await request.post('/api/telegram/webhook', { data: update })).status()).toBe(401);
  expect((await request.post('/api/telegram/webhook', { data: update, headers: { 'x-telegram-bot-api-secret-token': 'x'.repeat(40) } })).status()).toBe(401);
});
