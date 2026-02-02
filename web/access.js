/* ============================================================
   access.js — единый контекст ролей/баз + безопасное хранилище
   (без ES-modules, file:// совместимо)
   ============================================================ */

(function () {
  "use strict";

  if (window.AppContext && window.AppContext.__loaded_v1) return;

  var BASE_PREFIX = "papajkh_base_v1::";
  var ACTIVE_NS_KEY = "papajkh_active_base_v1";
  var LAST_NS_KEY = "papajkh_last_active_base_v1";

  var BASE_EXACT_KEYS = [
    "abonents_db_v1",
    "abonent_notes_v1",
    "exclude_periods_v1",
    "tariffs_v1",
    "refinancing_v1",
    "import_preview_v1",
    "jkh_import_draft_v1",
    "draft_new_abonent_v1",
    "payment_sources_v1",
    "tariffs_content_repair_v1",
    "tariffs_content_repair_v1_backup",
    "refinancing_rates_normal_v1",
    "refinancing_rates_moratorium_v1",
    "jkh_excel_date_debug",
    "last_abonent_id",
    "organization_requisites_v1",
    "organization_signers_v1"
  ];

  var BASE_PREFIX_KEYS = [
    "payments_",
    "note_",
    "exclude_periods_",
    "calc_period_",
    "calc_period_active_",
    "report_period_",
    "payments_ui_collapsed_",
    "moratorium_",
    "abonent_"
  ];

  function safeJsonParse(raw, fallback) {
    try { return JSON.parse(raw || ""); } catch (e) { return fallback; }
  }

  function getSession() {
    return safeJsonParse(localStorage.getItem("auth_session_v1") || "null", null);
  }

  function getCurrentUser() {
    try {
      if (window.Auth && typeof window.Auth.getCurrentUser === "function") {
        return window.Auth.getCurrentUser();
      }
    } catch (e) {}
    var sess = getSession();
    return sess && sess.userId ? { id: sess.userId, role: sess.role || "user" } : null;
  }

  function getRole() {
    var u = getCurrentUser();
    return (u && u.role) ? String(u.role) : "guest";
  }

  function getUserId() {
    var u = getCurrentUser();
    return u && u.id ? String(u.id) : "";
  }

  function defaultNamespace(role, userId) {
    if (role === "admin") return "admin";
    if (role === "user" && userId) return "user:" + userId;
    return "guest";
  }

  function normalizeNamespace(ns) {
    return String(ns || "").trim();
  }

  function setActiveNamespace(ns) {
    var value = normalizeNamespace(ns);
    if (!value) return;
    if (value !== "all") {
      try { localStorage.setItem(LAST_NS_KEY, value); } catch (e) {}
    }
    try { localStorage.setItem(ACTIVE_NS_KEY, value); } catch (e) {}
  }

  function getActiveNamespace() {
    var role = getRole();
    var userId = getUserId();
    var stored = normalizeNamespace(localStorage.getItem(ACTIVE_NS_KEY));

    if (role === "user") {
      var expected = defaultNamespace(role, userId);
      if (stored !== expected) {
        setActiveNamespace(expected);
        return expected;
      }
      return stored || expected;
    }

    if (role === "admin") {
      if (stored === "all") return stored;
      if (stored !== "admin") {
        setActiveNamespace("admin");
        return "admin";
      }
      return stored || "admin";
    }

    if (!stored) {
      var fallback = defaultNamespace(role, userId);
      setActiveNamespace(fallback);
      return fallback;
    }

    return stored;
  }

  function getReadNamespace() {
    var active = getActiveNamespace();
    if (active === "all") {
      var last = normalizeNamespace(localStorage.getItem(LAST_NS_KEY));
      if (last) return last;
      return defaultNamespace(getRole(), getUserId());
    }
    return active;
  }

  function isReadOnly() {
    var role = getRole();
    var active = getActiveNamespace();
    return role === "guest" || active === "all";
  }

  function isBaseKey(key) {
    if (!key) return false;
    if (BASE_EXACT_KEYS.indexOf(key) !== -1) return true;
    for (var i = 0; i < BASE_PREFIX_KEYS.length; i++) {
      if (key.indexOf(BASE_PREFIX_KEYS[i]) === 0) return true;
    }
    return false;
  }

  function buildKey(ns, key) {
    return BASE_PREFIX + String(ns || "guest") + "::" + String(key);
  }

  function scopedKey(key) {
    if (!isBaseKey(key)) return key;
    return buildKey(getReadNamespace(), key);
  }

  function migrateLegacyKey(key) {
    if (!isBaseKey(key)) return null;
    var legacy = localStorage.getItem(key);
    if (legacy === null || legacy === undefined) return null;
    if (!isReadOnly()) {
      try {
        localStorage.setItem(scopedKey(key), legacy);
        localStorage.removeItem(key);
      } catch (e) {}
    }
    return legacy;
  }

  function listNamespaces() {
    var out = {};
    for (var i = 0; i < localStorage.length; i++) {
      var k = localStorage.key(i);
      if (k && k.indexOf(BASE_PREFIX) === 0) {
        var rest = k.slice(BASE_PREFIX.length);
        var idx = rest.indexOf("::");
        if (idx !== -1) {
          out[rest.slice(0, idx)] = true;
        }
      }
    }
    return Object.keys(out);
  }

  function listBaseKeysForNamespace(ns) {
    var prefix = BASE_PREFIX + String(ns || getReadNamespace()) + "::";
    var out = [];
    for (var i = 0; i < localStorage.length; i++) {
      var k = localStorage.key(i);
      if (!k || k.indexOf(prefix) !== 0) continue;
      out.push(k.slice(prefix.length));
    }
    return out;
  }

  var storage = {
    getItem: function (key) {
      var scoped = localStorage.getItem(scopedKey(key));
      if (scoped !== null && scoped !== undefined) return scoped;
      return migrateLegacyKey(key);
    },
    setItem: function (key, value) {
      if (isReadOnly() && isBaseKey(key)) return;
      localStorage.setItem(scopedKey(key), value);
    },
    removeItem: function (key) {
      if (isReadOnly() && isBaseKey(key)) return;
      localStorage.removeItem(scopedKey(key));
    }
  };

  window.AppContext = {
    __loaded_v1: true,
    getRole: getRole,
    getUserId: getUserId,
    getActiveNamespace: getActiveNamespace,
    setActiveNamespace: setActiveNamespace,
    getReadNamespace: getReadNamespace,
    isReadOnly: isReadOnly,
    isBaseKey: isBaseKey,
    buildKey: buildKey,
    listNamespaces: listNamespaces,
    listBaseKeysForNamespace: listBaseKeysForNamespace,
    storage: storage
  };
})();
