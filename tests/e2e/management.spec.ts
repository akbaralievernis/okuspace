import { expect, test } from '@playwright/test';

const ID = '00000000-0000-4000-8000-000000000001';

test('management pages require a session', async ({ page }) => {
  for (const path of ['/ru/app/dashboard', '/ru/app/tasks', `/ru/app/tasks/${ID}`, '/ru/app/announcements', `/en/app/announcements/${ID}`]) {
    await page.goto(path);
    await expect(page, path).toHaveURL(/\/(ru|en)\/login\?next=/);
    await expect(page.locator('input[name="next"]'), path).toHaveValue(path);
  }
});
