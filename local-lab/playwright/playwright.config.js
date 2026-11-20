const { defineConfig } = require('@playwright/test');

const baseURL = process.env.JKH_LOCAL_BASE_URL || '';
if (baseURL !== 'http://nginx') {
  throw new Error('Playwright is restricted to the LOCAL_LAB nginx service');
}

module.exports = defineConfig({
  testDir: './tests',
  workers: 1,
  retries: 0,
  reporter: 'list',
  use: {
    baseURL,
    browserName: 'chromium',
    headless: true,
  },
});
