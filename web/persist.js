// persist.js — единый слой сохранения критичных данных

(function () {
  'use strict';

  function ensureOwner(ownerId) {
    var owner = String(ownerId || '').trim();
    if (!owner) throw new Error('ownerId is required');
    return owner;
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
      return JKHStore.getRaw(key, owner);
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
