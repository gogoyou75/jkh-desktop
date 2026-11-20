const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

class MemoryStorage {
  constructor() { this.values = new Map(); }
  get length() { return this.values.size; }
  key(index) { return Array.from(this.values.keys())[index] || null; }
  getItem(key) { return this.values.get(String(key)) ?? null; }
  setItem(key, value) { this.values.set(String(key), String(value)); }
  removeItem(key) { this.values.delete(String(key)); }
}

const localStorage = new MemoryStorage();
const document = {
  readyState: 'loading',
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener: () => {}
};
const window = {
  location: { protocol: 'http:', pathname: '/login.html', search: '' },
  Auth: { getCurrentUser: () => null, getActiveDbOwnerId: () => 'guest', isGuest: () => true },
  addEventListener: () => {},
  dispatchEvent: () => {},
  JKHBoot: { markReady: () => {} }
};
window.window = window;
window.document = document;
window.localStorage = localStorage;
const context = {
  window, document, localStorage, Storage: MemoryStorage, Auth: window.Auth,
  console, setTimeout, clearTimeout, setInterval: () => 1, clearInterval: () => {},
  URLSearchParams, CustomEvent: function () {}
};
context.globalThis = context;
vm.runInNewContext(
  fs.readFileSync(path.join(__dirname, '..', 'web', 'storage.js'), 'utf8'),
  context,
  { filename: 'storage.js' }
);

assert.strictEqual(window.JKHStorage.setEnvType('LOCAL_LAB'), true);
assert.strictEqual(window.JKHStorage.getEnvType(), 'LOCAL_LAB');
assert.strictEqual(window.JKHStorage.scopePrefixFor('synthetic-owner'),
  'jkhdb::LOCAL_LAB::synthetic-owner::');
assert.strictEqual(window.JKHStorage.setEnvType('UNKNOWN_ENV'), false);
assert.strictEqual(window.JKHStorage.getEnvType(), 'LOCAL_LAB');
console.log('LOCAL_LAB browser storage tests passed');
