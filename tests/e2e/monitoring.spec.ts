import { expect, test } from '@playwright/test';

const ID = '00000000-0000-4000-8000-000000000001';

test('monitoring pages require a session', async ({ page }) => {
  for (const path of ['/ru/app/monitoring', '/ru/app/monitoring/settings', `/ru/app/monitoring/rooms/${ID}`, '/ru/app/monitoring/notice']) {
    await page.goto(path);
    await expect(page, path).toHaveURL(/\/ru\/login\?next=/);
    await expect(page.locator('input[name="next"]'), path).toHaveValue(path);
  }
});

test('device ingestion refuses requests without a device token and never accepts images', async ({ request }) => {
  const reading = { kind: 'occupancy', count: 3, observedAt: new Date().toISOString() };
  expect((await request.post('/api/monitoring/ingest', { data: reading })).status()).toBe(401);
  const withImage = await request.post('/api/monitoring/ingest', {
    data: { ...reading, image: 'data:image/jpeg;base64,AAAA' },
    headers: { authorization: `Bearer ${ID}.${'a'.repeat(43)}` },
  });
  expect(withImage.status()).toBe(400);
  expect((await request.get('/api/monitoring/ingest')).status()).toBe(405);
});
