(function () {
  "use strict";

  window.JKH_READY = window.JKH_READY || {};

  function markReady(name) {
    try {
      var key = String(name || "").trim();
      if (!key) return false;
      window.JKH_READY[key] = true;
      return true;
    } catch (e) {
      return false;
    }
  }

  function isReady(name) {
    try {
      var key = String(name || "").trim();
      if (!key) return false;
      return !!window.JKH_READY[key];
    } catch (e) {
      return false;
    }
  }

  function getMissing(names) {
    try {
      var list = Array.isArray(names) ? names : [];
      var missing = [];
      for (var i = 0; i < list.length; i++) {
        var key = String(list[i] || "").trim();
        if (!key) continue;
        if (!window.JKH_READY[key]) missing.push(key);
      }
      return missing;
    } catch (e) {
      return [];
    }
  }

  function waitFor(names, timeoutMs) {
    var list;
    var timeout;
    try {
      list = Array.isArray(names) ? names : [];
      timeout = Number(timeoutMs);
      if (!Number.isFinite(timeout) || timeout < 0) timeout = 0;
    } catch (e) {
      list = [];
      timeout = 0;
    }

    return new Promise(function (resolve) {
      try {
        var startedAt = Date.now();

        function check() {
          try {
            if (getMissing(list).length === 0) {
              resolve(true);
              return;
            }
            if ((Date.now() - startedAt) >= timeout) {
              resolve(false);
              return;
            }
            setTimeout(check, 50);
          } catch (e) {
            resolve(false);
          }
        }

        check();
      } catch (e) {
        resolve(false);
      }
    });
  }

  window.JKHBoot = {
    markReady: markReady,
    isReady: isReady,
    waitFor: waitFor,
    getMissing: getMissing
  };
})();
