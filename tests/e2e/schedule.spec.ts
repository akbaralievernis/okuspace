import { expect, test } from '@playwright/test';

const ID = '00000000-0000-4000-8000-000000000001';

// Расписание, журнал посещаемости, аудитории и уведомления без сессии ведут на вход с путём возврата.
const PAGES = ['/ru/app/schedule', '/ru/app/schedule?week=2026-11-02', `/ru/app/schedule/sessions/${ID}`, '/ru/app/schedule/rooms', '/ru/app/notifications'];

test('schedule and attendance pages require a session', async ({ page }) => {
  for (const path of PAGES) {
    await page.goto(path);
    await expect(page, path).toHaveURL(/\/ru\/login\?next=/);
    await expect(page.locator('input[name="next"]'), path).toHaveValue(path.split('?')[0] === '/ru/app/schedule' && path.includes('?') ? '/ru/app/schedule' : path);
  }
});

test('a malformed session id is not found', async ({ page }) => {
  const res = await page.goto('/ru/app/schedule/sessions/not-a-uuid');
  expect(res?.status()).toBe(404);
});
