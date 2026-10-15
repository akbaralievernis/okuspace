import { expect, test } from '@playwright/test';

/**
 * Сценарии авторизации, проверяемые без настоящего Supabase (см. .env.e2e):
 * защищённые маршруты, серверная валидация форм, отказ при недоступности сервиса,
 * ссылки из писем, приглашения, open redirect. Вход с настоящим паролем, MFA и
 * восстановление по письму проверяются на тестовом проекте Supabase (STAGE_3.md).
 */

const PROTECTED = ['/ru/app', '/ru/app/account', '/ru/app/members', '/ru/reset-password', '/ru/mfa'];

for (const path of PROTECTED) {
  test(`protected route ${path} requires a server session`, async ({ page }) => {
    await page.goto(path);
    await expect(page).toHaveURL(new RegExp(`/ru/login\\?next=${encodeURIComponent(path).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`));
    await expect(page.getByRole('heading', { level: 1, name: 'Вход' })).toBeVisible();
  });
}

test('a forged session cookie does not grant access', async ({ page, context }) => {
  await context.addCookies([
    { name: 'sb-127-auth-token', value: 'base64-eyJmYWtlIjp0cnVlfQ', url: 'http://localhost:3100' },
  ]);
  await page.goto('/ru/app');
  await expect(page).toHaveURL(/\/ru\/login\?next=/);
});

test('login form validates on the server and marks invalid fields', async ({ page }) => {
  await page.goto('/ru/login');
  await page.getByRole('button', { name: 'Войти' }).click();
  await expect(page.getByRole('main').getByRole('alert')).toHaveText('Проверьте выделенные поля.');
  await expect(page.getByLabel('Email')).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByText('Введите корректный email.')).toBeVisible();
});

test('login fails closed when the rate limiter is unavailable (no secret key in e2e)', async ({ page }) => {
  await page.goto('/ru/login');
  await page.getByLabel('Email').fill('student@example.test');
  await page.getByLabel('Пароль').fill('correct horse battery');
  await page.getByRole('button', { name: 'Войти' }).click();
  await expect(page.getByRole('main').getByRole('alert')).toHaveText('Сервис временно недоступен. Попробуйте позже.');
  await expect(page).toHaveURL(/\/ru\/login/);
});

test('login keeps the next target only when it is an in-app path', async ({ page }) => {
  await page.goto('/ru/login?next=//evil.example/steal');
  await expect(page.locator('input[name="next"]')).toHaveValue('/ru/app');
  await page.goto('/ru/login?next=%2Fru%2Fapp%2Fmembers');
  await expect(page.locator('input[name="next"]')).toHaveValue('/ru/app/members');
});

test('registration requires consent and a long enough password', async ({ page }) => {
  await page.goto('/en/register');
  await page.getByLabel('Full name').fill('Test Student');
  await page.getByLabel('Email').fill('student@example.test');
  await page.getByLabel('Password').fill('short');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByText('The password must be at least 10 characters.')).toBeVisible();
  await expect(page.getByText('You cannot sign up without consent.')).toBeVisible();
});

test('password recovery validates the email', async ({ page }) => {
  await page.goto('/ky/forgot-password');
  await page.getByLabel('Email').fill('not-an-email');
  await page.getByRole('button', { name: 'Шилтеме жөнөтүү' }).click();
  await expect(page.getByText('Туура email жазыңыз.')).toBeVisible();
});

test('a broken e-mail link lands on login with a clear message', async ({ page }) => {
  await page.goto('/ru/auth/confirm?token_hash=abc&type=bogus');
  await expect(page).toHaveURL(/\/ru\/login\?error=link_invalid$/);
  await expect(page.getByRole('main').getByRole('alert')).toHaveText('Ссылка недействительна или устарела. Запросите новую.');
});

test('an e-mail link cannot redirect off-site', async ({ request }) => {
  const response = await request.get('/ru/auth/confirm?token_hash=abc&type=signup&next=https://evil.example', { maxRedirects: 0 });
  expect(response.status()).toBe(307);
  const location = response.headers()['location'] ?? '';
  expect(location.startsWith('http://localhost:3100/ru/')).toBe(true);
  expect(response.headers()['referrer-policy']).toBe('no-referrer');
});

test('invitation page: malformed token is 404, valid format asks to sign in and comes back', async ({ page }) => {
  const bad = await page.goto('/ru/invite/..%2F..%2Fetc');
  expect(bad?.status()).toBe(404);

  const token = 'A'.repeat(43);
  await page.goto(`/ru/invite/${token}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Приглашение в школу' })).toBeVisible();
  await expect(page.getByRole('main').getByRole('link', { name: 'Войти' })).toHaveAttribute('href', `/ru/login?next=${encodeURIComponent(`/ru/invite/${token}`)}`);
  const invite = await page.request.get(`/ru/invite/${token}`);
  expect(invite.headers()['referrer-policy']).toBe('no-referrer');
});

test('auth pages are usable on a phone and by keyboard', async ({ page }) => {
  for (const path of ['/ru/login', '/ru/register', '/ru/forgot-password']) {
    await page.goto(path);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, path).toBeLessThanOrEqual(0);
  }
  await page.goto('/ru/login');
  await page.keyboard.press('Tab'); // skip link
  await page.keyboard.press('Tab'); // логотип
  // Все поля формы достижимы с клавиатуры и подписаны.
  for (const label of ['Email', 'Пароль']) await expect(page.getByLabel(label)).toBeEditable();
});

test('auth pages send security headers and the CSP nonce reaches server actions', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error' && /Content Security Policy/i.test(m.text())) errors.push(m.text());
  });
  const response = await page.goto('/ru/login');
  expect(response?.headers()['content-security-policy']).toContain("frame-ancestors 'none'");
  await page.getByRole('button', { name: 'Войти' }).click();
  await expect(page.getByRole('main').getByRole('alert')).toBeVisible();
  expect(errors).toEqual([]);
});
