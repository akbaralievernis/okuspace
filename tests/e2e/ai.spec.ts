import { expect, test } from '@playwright/test';

const ID = '00000000-0000-4000-8000-000000000001';

// Страницы AI-практики без сессии ведут на вход с путём возврата; некорректный id → 404.
const PAGES = ['/ru/app/ai', `/ru/app/ai/conversations/${ID}`, `/ru/app/ai/feedback/${ID}`, `/ru/app/ai/practice/${ID}`, '/ru/app/ai/settings', '/ru/app/ai/reviews'];

test('AI practice pages require a session', async ({ page }) => {
  for (const path of PAGES) {
    await page.goto(path);
    await expect(page, path).toHaveURL(/\/ru\/login\?next=/);
    await expect(page.locator('input[name="next"]'), path).toHaveValue(path);
  }
});

test('malformed AI ids are not found', async ({ page }) => {
  for (const path of ['/ru/app/ai/conversations/x', '/ru/app/ai/feedback/1', '/ru/app/ai/practice/abc']) {
    expect((await page.goto(path))?.status(), path).toBe(404);
  }
});
