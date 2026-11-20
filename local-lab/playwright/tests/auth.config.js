const { defineConfig } = require('@playwright/test');

if (process.env.JKH_LOCAL_BASE_URL !== 'http://nginx') {
  throw new Error('Authentication test is restricted to LOCAL_LAB nginx');
}

module.exports = defineConfig({
  testDir: __dirname,
  testMatch: 'auth.spec.js',
  workers: 1,
  retries: 0,
  reporter: 'list',
  globalSetup: require.resolve('./auth.global-setup.js'),
  use: {
    baseURL: 'http://nginx',
    browserName: 'chromium',
    headless: true,
    trace: 'off',
    screenshot: 'off',
    video: 'off',
  },
});
