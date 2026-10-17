import { expect, test } from '@playwright/test';

/**
 * Публичный сайт без базы данных (e2e-окружение): все страницы доступны и честно
 * показывают «временно недоступно»/«пока пусто», ссылки ведут на существующие страницы.
 * Отрисовку с реальными данными проверяет интеграционный тест схем + проверка на Supabase (STAGE_4.md).
 */

export const PUBLIC_PAGES = [
  '/ru',
  '/ru/courses',
  '/ru/levels',
  '/ru/branches',
  '/ru/teachers',
  '/ru/prices',
  '/ru/trial',
  '/ru/contacts',
  '/ru/about',
  '/ru/faq',
  '/ru/legal/privacy',
  '/ru/legal/terms',
  '/ru/legal/personal-data',
  '/ru/login',
  '/ru/register',
];

for (const path of PUBLIC_PAGES) {
  test(`public page ${path} is available with a single h1`, async ({ page }) => {
    const response = await page.goto(path);
    expect(response?.status()).toBe(200);
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
    await expect(page.getByRole('banner')).toBeVisible();
    await expect(page.getByRole('contentinfo')).toBeVisible();
  });
}

test('without the database pages say so instead of showing invented content', async ({ page }) => {
  for (const path of ['/ru/courses', '/ru/branches', '/ru/teachers', '/ru/prices', '/ru/trial', '/ru/about', '/ru/legal/privacy']) {
    await page.goto(path);
    await expect(page.getByRole('main').getByText('Информация временно недоступна'), path).toBeVisible();
  }
});

test('malformed ids and unknown documents return 404', async ({ request }) => {
  for (const path of ['/ru/courses/not-a-uuid', '/ru/legal/cookies', '/ru/no-such-page']) {
    const response = await request.get(path);
    expect(response.status(), path).toBe(404);
  }
});

test('a course page without the database says so rather than claiming the course does not exist', async ({ page }) => {
  // Без БД нельзя знать, существует ли курс: честный ответ — «временно недоступно», а не 404.
  await page.goto('/ru/courses/00000000-0000-4000-8000-000000000000');
  await expect(page.getByRole('main').getByText('Информация временно недоступна')).toBeVisible();
});

test('every link in the header and footer leads to an existing page', async ({ page, request }) => {
  await page.goto('/ru');
  const hrefs = await page.$$eval('header a[href], footer a[href]', (links) => [...new Set(links.map((a) => a.getAttribute('href') ?? ''))]);
  const internal = hrefs.filter((h) => h.startsWith('/'));
  expect(internal.length).toBeGreaterThanOrEqual(15);
  for (const href of internal) {
    const response = await request.get(href, { maxRedirects: 0 });
    expect(response.status(), href).toBeLessThan(400);
  }
});

test('language switch keeps the catalog filters', async ({ page }) => {
  await page.goto('/ru/courses?format=online&language=en');
  await page.getByRole('link', { name: 'English' }).first().click();
  await expect(page).toHaveURL(/\/en\/courses\?format=online&language=en$/);
});

test('staff tools require a session', async ({ page }) => {
  for (const path of ['/ru/app/site', '/ru/app/requests', '/ru/app/trials', '/ru/app/profile']) {
    await page.goto(path);
    await expect(page, path).toHaveURL(/\/ru\/login\?next=/);
  }
});

test.describe('mobile navigation', () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test('menu opens and closes with the keyboard and returns focus', async ({ page }) => {
    await page.goto('/ru');
    const button = page.getByRole('button', { name: 'Меню' });
    await expect(button).toHaveAttribute('aria-expanded', 'false');
    await button.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('button', { name: 'Закрыть' })).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByRole('navigation', { name: 'Основное меню' }).getByRole('link', { name: 'Курсы', exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: 'Меню' })).toBeFocused();
    await expect(page.getByRole('button', { name: 'Меню' })).toHaveAttribute('aria-expanded', 'false');
  });

  test('no horizontal scroll on public pages', async ({ page }) => {
    for (const path of PUBLIC_PAGES) {
      await page.goto(path);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow, path).toBeLessThanOrEqual(0);
    }
  });
});
