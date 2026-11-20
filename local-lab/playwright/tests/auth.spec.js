const { test, expect } = require('@playwright/test');

test('synthetic LOCAL_LAB user signs in and out through the site', async ({ page }) => {
  const email = process.env.JKH_FIXTURE_EMAIL;
  const password = process.env.JKH_FIXTURE_PASSWORD;
  if (!email || !password) throw new Error('Fixture credentials were not supplied');

  const health = await page.context().request.get('/api/health');
  expect(health.status()).toBe(200);
  expect(await health.json()).toMatchObject({ status: 'ok', env_type: 'LOCAL_LAB' });

  await page.goto('/login.html');
  await page.locator('#loginEmail').fill(email);
  await page.locator('#loginPass').fill(password);
  await page.locator('#loginRemember').selectOption('0');
  await page.locator('#rememberEmail').uncheck();
  await page.getByRole('button', { name: 'Войти' }).click();

  await expect(page).toHaveURL(/\/index\.html$/);
  const me = await page.context().request.get('/api/auth/me');
  expect(me.status()).toBe(200);
  const session = await me.json();
  expect(session).toMatchObject({ ok: true, env_type: 'LOCAL_LAB' });
  expect(session.user.email).toBe(email);
  expect(session.user.role).toBe('user');
  await expect(page.getByRole('heading', { name: 'ОБЩАЯ ИНФОРМАЦИЯ ПО КАЖДОМУ АБОНЕНТУ' })).toBeVisible();

  await page.getByRole('button', { name: 'выйти' }).click();
  await expect.poll(async () => (await page.context().request.get('/api/auth/me')).status()).toBe(401);
});
