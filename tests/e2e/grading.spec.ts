import { expect, test } from '@playwright/test';

const ID = '00000000-0000-4000-8000-000000000001';

test('gradebook, exams, reports and grading rules require a session', async ({ page }) => {
  for (const path of [`/ru/app/groups/${ID}/grades`, `/ru/app/groups/${ID}/exams`, '/ru/app/learn/reports', '/ky/app/grading']) {
    await page.goto(path);
    await expect(page, path).toHaveURL(/\/(ru|ky)\/login\?next=/);
    await expect(page.locator('input[name="next"]'), path).toHaveValue(path);
  }
});
