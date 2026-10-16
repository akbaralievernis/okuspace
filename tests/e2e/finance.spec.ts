import { expect, test } from '@playwright/test';

const ID = '00000000-0000-4000-8000-000000000001';

test('finance and billing pages require a session', async ({ page }) => {
  for (const path of ['/ru/app/finance', '/ru/app/finance/invoices', `/ru/app/finance/invoices/${ID}`, '/ru/app/finance/payments', '/ru/app/finance/expenses', '/ru/app/finance/prices', '/ru/app/billing']) {
    await page.goto(path);
    await expect(page, path).toHaveURL(/\/ru\/login\?next=/);
    await expect(page.locator('input[name="next"]'), path).toHaveValue(path);
  }
});

test('the payment webhook is closed when no provider is configured', async ({ request }) => {
  const res = await request.post('/api/payments/webhook/test_psp', {
    data: { type: 'payment.succeeded', eventId: 'e', operationId: 'o', invoiceId: ID, amount: '1.00', currency: 'KGS' },
  });
  expect(res.status()).toBe(404);
  expect((await request.get('/api/payments/webhook/test_psp')).status()).toBe(405);
});

test('a malformed invoice id is not found', async ({ page }) => {
  expect((await page.goto('/ru/app/finance/invoices/1'))?.status()).toBe(404);
});
