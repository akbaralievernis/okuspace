import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

/**
 * Автоматическая проверка доступности (axe-core) по WCAG 2.2 A/AA.
 * Критерий этапа 4: нет нарушений уровня serious/critical. Остальные — во вложении к отчёту.
 * Автоматика ловит ~30–40 % проблем; ручная проверка с экранным диктором — в чек-листе STAGE_4.md.
 */
const PAGES = [
  '/ru',
  '/ky',
  '/en',
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
  '/ru/login',
  '/ru/register',
  '/ru/forgot-password',
  '/ky/login',
  '/en/contacts',
];

for (const path of PAGES) {
  test(`no serious accessibility violations on ${path}`, async ({ page }, testInfo) => {
    await page.goto(path);
    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
    if (results.violations.length) {
      await testInfo.attach('axe-violations', { body: JSON.stringify(results.violations, null, 2), contentType: 'application/json' });
    }
    const blocking = results.violations
      .filter((v) => v.impact === 'serious' || v.impact === 'critical')
      .map((v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`);
    expect(blocking).toEqual([]);
  });
}

test('login error state is accessible', async ({ page }) => {
  await page.goto('/ru/login');
  await page.getByRole('button', { name: 'Войти' }).click();
  await expect(page.getByRole('main').getByRole('alert')).toBeVisible();
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
  expect(results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => v.id)).toEqual([]);
});
