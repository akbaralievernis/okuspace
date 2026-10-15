import { expect, test } from '@playwright/test';

const locales = [
  { code: 'ky', heading: 'Okuspace', status: 'Платформа иштелип чыгууда' },
  { code: 'ru', heading: 'Okuspace', status: 'Платформа в разработке' },
  { code: 'en', heading: 'Okuspace', status: 'Platform under development' },
] as const;

for (const { code, heading, status } of locales) {
  test(`home page renders in ${code}`, async ({ page }) => {
    const response = await page.goto(`/${code}`);
    expect(response?.status()).toBe(200);
    await expect(page.locator('html')).toHaveAttribute('lang', code);
    await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
    await expect(page.getByText(status)).toBeVisible();
  });
}

test('root redirects to the negotiated locale and keeps the query', async ({ browser }) => {
  const context = await browser.newContext({ locale: 'ky-KG' });
  const page = await context.newPage();
  await page.goto('/?ref=test');
  await expect(page).toHaveURL(/\/ky\?ref=test$/);
  await context.close();
});

test('language switch keeps the path and query string', async ({ page }) => {
  await page.goto('/ru?utm=1');
  await page.getByRole('link', { name: 'English' }).click();
  await expect(page).toHaveURL(/\/en\?utm=1$/);
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.getByRole('link', { name: 'English' })).toHaveAttribute('aria-current', 'true');
});

test('unsupported locale returns 404', async ({ page }) => {
  const response = await page.goto('/de');
  expect(response?.status()).toBe(404);
});

test('security headers are present and CSP nonce is applied to scripts', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });

  const response = await page.goto('/ru');
  const headers = response?.headers() ?? {};
  const csp = headers['content-security-policy'] ?? '';
  const nonce = /'nonce-([^']+)'/.exec(csp)?.[1];

  expect(nonce, 'CSP must contain a nonce').toBeTruthy();
  expect(csp).toContain("frame-ancestors 'none'");
  expect(csp).not.toContain('unsafe-eval');
  expect(headers['x-content-type-options']).toBe('nosniff');
  expect(headers['strict-transport-security']).toContain('max-age=');
  expect(headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
  expect(headers['x-powered-by']).toBeUndefined();

  const scriptsWithoutNonce = await page.$$eval('script', (scripts) =>
    scripts.filter((s) => !s.nonce && !s.getAttribute('nonce')).length,
  );
  expect(scriptsWithoutNonce).toBe(0);
  expect(errors.filter((e) => /Content Security Policy/i.test(e))).toEqual([]);
});

test('nonce differs between requests', async ({ request }) => {
  const a = (await request.get('/ru')).headers()['content-security-policy'];
  const b = (await request.get('/ru')).headers()['content-security-policy'];
  expect(a).not.toEqual(b);
});

test('health endpoint answers without exposing configuration', async ({ request }) => {
  const response = await request.get('/api/health');
  expect(response.status()).toBe(200);
  const body = await response.json();
  expect(body.status).toBe('ok');
  expect(Object.keys(body).sort()).toEqual(['status', 'time']);
});

test('no horizontal scroll and skip link works', async ({ page }) => {
  await page.goto('/ru');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);

  await page.keyboard.press('Tab');
  const skip = page.getByRole('link', { name: 'Перейти к содержимому' });
  await expect(skip).toBeFocused();
});
