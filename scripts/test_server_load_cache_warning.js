const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const repoRoot = path.resolve(__dirname, "..");
const storageSource = fs.readFileSync(path.join(repoRoot, "web", "storage.js"), "utf8");
const authSource = fs.readFileSync(path.join(repoRoot, "web", "auth.js"), "utf8");
const paymentSource = fs.readFileSync(path.join(repoRoot, "web", "payment_table.js"), "utf8");

class MemoryStorage {
  constructor(failureFactory) {
    this.values = new Map();
    this.failureFactory = failureFactory || null;
  }
  get length() { return this.values.size; }
  key(index) { return Array.from(this.values.keys())[index] || null; }
  getItem(key) { return this.values.has(String(key)) ? this.values.get(String(key)) : null; }
  setItem(key, value) {
    if (this.failureFactory && String(key).includes("abonents_db_v1")) throw this.failureFactory(String(key));
    this.values.set(String(key), String(value));
  }
  removeItem(key) { this.values.delete(String(key)); }
  clear() { this.values.clear(); }
}

const populatedDb = {
  abonents: { "1": { id: "1", uid: "uid_test", ownerId: "owner-1" } },
  premises: {},
  links: []
};

function response(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(payload),
    json: async () => payload
  };
}

function createStorageContext({ failureFactory, fetchImpl } = {}) {
  const localStorage = new MemoryStorage(failureFactory);
  const documentStub = {
    readyState: "loading",
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: () => {},
    createEvent: () => ({ initEvent: () => {} })
  };
  const windowStub = {
    location: { protocol: "http:", pathname: "/abonent_card.html", search: "?abonent=1" },
    Auth: { getCurrentUser: () => ({ id: "owner-1", role: "user" }), isGuest: () => false },
    addEventListener: () => {},
    dispatchEvent: () => {},
    JKHBoot: { markReady: () => {} },
    __JKH_STORAGE_TEST_HOOKS: true
  };
  const context = {
    window: windowStub,
    document: documentStub,
    localStorage,
    Storage: MemoryStorage,
    Auth: windowStub.Auth,
    fetch: fetchImpl || (async () => response({
      ok: true,
      owner: "owner-1",
      env_type: "LAB",
      data: { abonents_db_v1: JSON.stringify(populatedDb) }
    })),
    console,
    setTimeout,
    clearTimeout,
    setInterval: () => 1,
    clearInterval: () => {},
    URLSearchParams,
    CustomEvent: function CustomEvent() {}
  };
  context.globalThis = context;
  windowStub.window = windowStub;
  windowStub.document = documentStub;
  windowStub.localStorage = localStorage;
  vm.runInNewContext(storageSource, context, { filename: "storage.js" });
  return context;
}

async function loadWith(options) {
  const context = createStorageContext(options);
  const result = await context.window.JKHDataLoader.loadFromServer({ reason: "test", force: true });
  return { context, result, ui: context.window.JKH_UI_STATE };
}

function quotaError(key) {
  const error = new Error("Quota exceeded while writing " + key);
  error.name = "QuotaExceededError";
  error.code = 22;
  return error;
}

function genericCacheError(key) {
  const error = new Error("Cache device rejected " + key);
  error.name = "InvalidStateError";
  return error;
}

function assertReadableSuccess(outcome, warningExpected) {
  assert.strictEqual(outcome.result.ok, true);
  assert.strictEqual(outcome.result.status, "ready");
  assert.strictEqual(outcome.result.serverStatus, "online");
  assert.strictEqual(outcome.ui.server.status, "online");
  assert.strictEqual(outcome.ui.data.status, "ready");
  assert.strictEqual(outcome.ui.data.source, "server");
  assert.strictEqual(!!outcome.result.cacheWarning, warningExpected);
}

function paymentReadableFor(uiState) {
  const documentStub = {
    querySelector: () => null,
    querySelectorAll: () => [],
    getElementById: () => null,
    addEventListener: () => {},
    removeEventListener: () => {},
    createElement: () => ({ appendChild: () => {}, style: {}, dataset: {}, classList: { add: () => {} } }),
    createDocumentFragment: () => ({ appendChild: () => {} }),
    head: { appendChild: () => {} }
  };
  const windowStub = {
    __JKH_PAYMENT_TABLE_TEST_HOOKS: true,
    JKH_UI_STATE: JSON.parse(JSON.stringify(uiState)),
    location: { search: "?abonent=1" },
    addEventListener: () => {},
    removeEventListener: () => {},
    setTimeout,
    clearTimeout
  };
  const context = {
    window: windowStub,
    document: documentStub,
    console,
    setTimeout,
    clearTimeout,
    URLSearchParams,
    performance: { now: () => 0 },
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} }
  };
  context.globalThis = context;
  windowStub.window = windowStub;
  windowStub.document = documentStub;
  vm.runInNewContext(paymentSource, context, { filename: "payment_table.js" });
  return context.window.__paymentTableTestHooks.serverFirstReadableState();
}

(async () => {
  const success = await loadWith();
  assertReadableSuccess(success, false);
  assert.strictEqual(success.result.warning, "");

  const empty = await loadWith({ fetchImpl: async () => response({
    ok: true,
    owner: "owner-1",
    env_type: "LAB",
    data: { abonents_db_v1: JSON.stringify({ abonents: {}, premises: {}, links: [] }) }
  }) });
  assert.strictEqual(empty.result.ok, true);
  assert.strictEqual(empty.result.status, "empty");
  assert.strictEqual(empty.ui.server.status, "online");
  assert.strictEqual(empty.ui.data.status, "empty");
  assert.strictEqual(empty.ui.data.source, "server");
  assert.strictEqual(empty.result.cacheWarning, null);

  const quota = await loadWith({ failureFactory: quotaError });
  assertReadableSuccess(quota, true);
  assert.strictEqual(quota.result.cacheWarning.quotaExceeded, true);
  assert.strictEqual(quota.result.warning, "LOCAL_CACHE_WRITE_FAILED");
  assert.ok(quota.result.cacheWarning.failedStorageKey.includes("abonents_db_v1"));

  const generic = await loadWith({ failureFactory: genericCacheError });
  assertReadableSuccess(generic, true);
  assert.strictEqual(generic.result.cacheWarning.quotaExceeded, false);
  assert.strictEqual(generic.result.cacheWarning.errorName, "InvalidStateError");

  const network = await loadWith({ fetchImpl: async () => { throw new TypeError("Failed to fetch"); } });
  assert.strictEqual(network.result.ok, false);
  assert.strictEqual(network.result.status, "offline");
  assert.strictEqual(network.ui.server.status, "offline");
  assert.strictEqual(network.ui.data.status, "offline");

  const invalid = await loadWith({ fetchImpl: async () => response({ ok: true, owner: "owner-1", env_type: "LAB", data: { abonents_db_v1: "not-json" } }) });
  assert.strictEqual(invalid.result.ok, false);
  assert.strictEqual(invalid.result.status, "invalid");
  assert.strictEqual(invalid.ui.server.status, "online");
  assert.strictEqual(invalid.ui.data.status, "invalid");

  const authDocument = { readyState: "loading", addEventListener: () => {}, querySelector: () => null, querySelectorAll: () => [] };
  const authWindow = { document: authDocument, localStorage: new MemoryStorage(), JKHBoot: { markReady: () => {} }, addEventListener: () => {}, location: { pathname: "/abonent_card.html" } };
  const authContext = { window: authWindow, document: authDocument, localStorage: authWindow.localStorage, console, fetch: async () => response({}), setTimeout, clearTimeout, URLSearchParams };
  authContext.globalThis = authContext;
  authWindow.window = authWindow;
  vm.runInNewContext(authSource, authContext, { filename: "auth.js" });
  const authPatch = authWindow.Auth.__testHooks.authAutoloadSuccessDataPatch(quota.result, quota.result.status);
  assert.strictEqual(authPatch.status, "ready");
  assert.strictEqual(authPatch.source, "server");
  assert.strictEqual(authPatch.cacheWarning.quotaExceeded, true);

  const manualReadable = paymentReadableFor(quota.ui);
  assert.strictEqual(manualReadable.ok, true, "quota warning must not cause DATA_READY_TIMEOUT_READABLE");

  console.log("server load cache warning tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
