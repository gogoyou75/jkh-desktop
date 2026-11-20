const { test, expect } = require('@playwright/test');

test('LOCAL_LAB API and browser page are available', async ({ page, request }) => {
  const health = await request.get('/api/health');
  expect(health.ok()).toBeTruthy();
  expect(await health.json()).toMatchObject({ status: 'ok', env_type: 'LOCAL_LAB' });

  const environment = await request.get('/api/env');
  expect(environment.ok()).toBeTruthy();
  expect(await environment.json()).toMatchObject({ ok: true, env_type: 'LOCAL_LAB' });

  const response = await page.goto('/login.html', { waitUntil: 'domcontentloaded' });
  expect(response.status()).toBe(200);
  expect(new URL(page.url()).origin).toBe('http://nginx');
  await expect(page.locator('body')).not.toBeEmpty();
  await expect.poll(() => page.evaluate(() => window.JKHStorage?.fetchEnvType?.())).toBe('LOCAL_LAB');
  expect(await page.evaluate(() => window.JKHStorage.scopePrefixFor('synthetic-owner')))
    .toBe('jkhdb::LOCAL_LAB::synthetic-owner::');

  const premises = await request.get('/premises.html');
  expect(premises.status()).toBe(200);
});
