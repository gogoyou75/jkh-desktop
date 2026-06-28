// persist.js — единый слой сохранения критичных данных

(function () {
  'use strict';

  function ensureOwner(ownerId) {
    var owner = normalizeOwnerId(ownerId);
    if (!owner) throw new Error('ownerId is required');
    return owner;
  }

  function normalizeOwnerId(ownerId) {
    try {
      if (window.JKHStore && typeof JKHStore.normalizeOwnerId === 'function') return JKHStore.normalizeOwnerId(ownerId);
      if (window.Auth && typeof Auth.normalizeOwnerId === 'function') return Auth.normalizeOwnerId(ownerId);
    } catch (e) {}
    var value = String(ownerId || '').trim();
    var upper = value.toUpperCase();
    if (upper.indexOf('LAB:') === 0) return value.slice(4).trim();
    if (upper.indexOf('PROD:') === 0) return value.slice(5).trim();
    return value;
  }

  function ensureStore() {
    if (!window.JKHStore) throw new Error('JKHStore is not available');
  }

  function isApiOk(data) {
    return !!data && (data.ok === true || data.status === 'ok');
  }

  async function postStore(ownerId, key, value) {
    var res = await fetch('/api/store', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_owner_hint: ownerId, key: key, value: value })
    });

    var data = null;
    try { data = await res.json(); } catch (e) {}

    var ok = isApiOk(data);
    console.log('[persist][api-store] key=' + key + ' status=' + (ok ? 'ok' : 'fail'));

    if (!ok) {
      var msg = (data && (data.error || data.message)) ? (data.error || data.message) : ('HTTP ' + res.status);
      throw new Error(msg);
    }

    return data;
  }

  function verifyLocal(key, expectedValue, ownerId) {
    ensureStore();
    var actual = JKHStore.getRaw(key, ownerId);
    var ok = String(actual == null ? '' : actual) === String(expectedValue == null ? '' : expectedValue);
    console.log('[persist][verify] key=' + key + ' ' + (ok ? 'ok' : 'fail'));
    if (!ok) throw new Error('verify failed for key=' + key);
    return true;
  }

  var tariffReadDiagSeen = {};

  function diagnoseTariffServerRead(ownerId, key, localRaw) {
    try {
      var k = String(key || "");
      if (k.indexOf("tariffs_") !== 0) return;
      var owner = normalizeOwnerId(ownerId);
      if (!owner || typeof fetch !== "function") return;
      var sig = owner + "|" + k;
      var now = Date.now ? Date.now() : (new Date()).getTime();
      if (tariffReadDiagSeen[sig] && now - tariffReadDiagSeen[sig] < 2000) return;
      tariffReadDiagSeen[sig] = now;
      var localValue = (localRaw === null || localRaw === undefined) ? "" : String(localRaw);
      fetch('/api/store?key=' + encodeURIComponent(k) + '&client_owner_hint=' + encodeURIComponent(owner), { credentials: 'include' })
        .then(function (r) { return r.json().catch(function () { return null; }); })
        .then(function (data) {
          var serverValue = data && Object.prototype.hasOwnProperty.call(data, 'value') && data.value !== null && data.value !== undefined
            ? String(data.value)
            : "";
          console.log('[diagnose][tariff-server-read]', {
            source: 'JKHPersist.get',
            ownerId: owner,
            key: k,
            localExists: localValue !== "",
            serverExists: !!(data && data.ok === true && serverValue !== ""),
            serverLength: serverValue.length,
            localLength: localValue.length
          });
        })
        .catch(function (e) {
          console.warn('[diagnose][tariff-server-read]', {
            source: 'JKHPersist.get',
            ownerId: owner,
            key: k,
            localExists: localValue !== "",
            serverExists: null,
            serverLength: 0,
            localLength: localValue.length,
            error: String(e && e.message || e)
          });
        });
    } catch (eDiagTariffServerRead) {}
  }

  window.JKHPersist = {
    set: async function (key, value, ownerId, options) {
      var owner = ensureOwner(ownerId);
      void options;
      ensureStore();

      console.log('[persist][set] key=' + key + ' owner=' + owner);

      JKHStore.setRaw(key, value, owner);
      await postStore(owner, key, value);
      JKHStore.setRaw(key, value, owner);
      verifyLocal(key, value, owner);
      return true;
    },

    get: function (key, ownerId) {
      var owner = ensureOwner(ownerId);
      ensureStore();
      var raw = JKHStore.getRaw(key, owner);
      diagnoseTariffServerRead(owner, key, raw);
      return raw;
    },

    remove: async function (key, ownerId) {
      var owner = ensureOwner(ownerId);
      ensureStore();

      console.log('[persist][set] key=' + key + ' owner=' + owner);
      JKHStore.setRaw(key, '', owner);
      await postStore(owner, key, '');

      if (typeof JKHStore.removeRaw === 'function') JKHStore.removeRaw(key, owner);
      verifyLocal(key, '', owner);
      return true;
    },

    verify: function (key, expectedValue, ownerId) {
      var owner = ensureOwner(ownerId);
      return verifyLocal(key, expectedValue, owner);
    }
  };
})();
