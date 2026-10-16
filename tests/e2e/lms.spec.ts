import { expect, test } from '@playwright/test';

const ID = '00000000-0000-4000-8000-000000000001';

// Без серверной сессии все страницы обучения и управления курсами ведут на вход и сохраняют путь возврата.
const LMS_PAGES = [
  '/ru/app/learn',
  `/ru/app/learn/${ID}`,
  `/ru/app/learn/lessons/${ID}`,
  `/ru/app/learn/tests/${ID}`,
  `/ru/app/learn/attempts/${ID}`,
  `/ru/app/learn/homework/${ID}`,
  '/ru/app/courses',
  `/ru/app/courses/${ID}`,
  `/ru/app/courses/${ID}/tests/${ID}`,
  '/ru/app/groups',
  `/ru/app/groups/${ID}`,
  '/ru/app/catalog',
];

test('learning and course tools require a session', async ({ page }) => {
  for (const path of LMS_PAGES) {
    await page.goto(path);
    await expect(page, path).toHaveURL(/\/ru\/login\?next=/);
    await expect(page.locator('input[name="next"]'), path).toHaveValue(path);
  }
});

test('malformed ids are not found, not errors', async ({ page }) => {
  for (const path of ['/ru/app/learn/not-a-uuid', '/ru/app/learn/tests/1']) {
    const res = await page.goto(path);
    // Сначала проверяется формат id (404), затем сессия.
    expect(res?.status(), path).toBe(404);
  }
});
