import { expect, test } from '@playwright/test';

const ID = '00000000-0000-4000-8000-000000000001';

// CRM без сессии: страницы ведут на вход; выгрузка CSV не отдаёт данные.
test('CRM pages require a session', async ({ page }) => {
  for (const path of ['/ru/app/crm', `/ru/app/crm/contacts/${ID}`, '/ru/app/crm/import']) {
    await page.goto(path);
    await expect(page, path).toHaveURL(/\/ru\/login\?next=/);
    await expect(page.locator('input[name="next"]'), path).toHaveValue(path);
  }
});

test('CSV export without a session redirects to login and returns no CSV', async ({ request }) => {
  const res = await request.get(`/ru/app/crm/export?org=${ID}`, { maxRedirects: 0 });
  expect([302, 303, 307, 308]).toContain(res.status());
  expect(res.headers()['location']).toMatch(/\/ru\/login\?next=/);
  expect(res.headers()['content-type'] ?? '').not.toContain('text/csv');
});

test('a malformed contact id is not found', async ({ page }) => {
  expect((await page.goto('/ru/app/crm/contacts/42'))?.status()).toBe(404);
});
