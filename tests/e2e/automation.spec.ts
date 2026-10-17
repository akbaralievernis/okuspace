import { expect, test } from '@playwright/test';

test('billing, payroll and make-up pages require a session', async ({ page }) => {
  for (const path of ['/ru/app/finance/billing', '/ru/app/payroll', '/ru/app/schedule/makeups', '/en/app/payroll']) {
    await page.goto(path);
    await expect(page, path).toHaveURL(/\/(ru|en)\/login\?next=/);
    await expect(page.locator('input[name="next"]'), path).toHaveValue(path);
  }
});
