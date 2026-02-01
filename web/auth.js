/* ============================================================
   auth.js — OFFLINE-FIRST (LEGACY / NO-ASYNC)
   localStorage auth + admin api

   FIX (2026-02-01):
   - Регистрация:
       * если пользователей 0 -> первый становится ADMIN
       * если пользователи уже есть -> регистрация создаёт USER
       * НЕ БЛОКИРУЕМ регистрацию обычных пользователей
       * Оставлена совместимость: Auth.registerFirstAdmin(...) теперь работает как "register"
   - В шапке вместо имени всегда показываем EMAIL
   - Ссылка "Резервные копии" ведёт:
       admin -> admin.html#backupStatus
       user  -> user_panel.html#statusBox
   - admin.html не пустая: добавлены методы getSessionUser/adminListUsers/...
   ============================================================ */

(function () {
  "use strict";

  // ------------------ utils ------------------
  function nowMs() { return Date.now(); }
  function safeJsonParse(s, fallback) { try { return JSON.parse(s); } catch (e) { return fallback; } }
  function safeJsonStringify(v) { try { return JSON.stringify(v); } catch (e) { return ""; } }

  function randHex(len) {
    var out = "";
    var chars = "abcdef0123456789";
    for (var i = 0; i < len; i++) out += chars.charAt(Math.floor(Math.random() * chars.length));
    return out;
  }

  function normalizeEmail(email) { return String(email || "").trim().toLowerCase(); }

  // ------------------ storage keys ------------------
  var K_USERS = "auth_users_v1";
  var K_SESS  = "auth_session_v1";
  var K_BOOT  = "auth_bootstrap_secrets_v1";

  // мастер-ключ (хэш + одноразовый показ)
  var K_MASTER_HASH    = "auth_master_key_hash_v1";
  var K_MASTER_PENDING = "auth_master_key_pending_v1";

  // ------------------ crypto-lite (офлайн-прототип) ------------------
  function hashPass(pw) {
    pw = String(pw || "");
    var h = 2166136261;
    for (var i = 0; i < pw.length; i++) {
      h ^= pw.charCodeAt(i);
      h = (h * 16777619) >>> 0;
    }
    return ("00000000" + h.toString(16)).slice(-8);
  }

  // ------------------ users db ------------------
  function saveUsers(users) {
    localStorage.setItem(K_USERS, safeJsonStringify(users || []));
  }

  // Всегда возвращаем массив, если битое значение — лечим.
  // + нормализуем поля role/disabled/displayName/id/email
  function loadUsers() {
    var raw = localStorage.getItem(K_USERS);
    var parsed = safeJsonParse(raw || "[]", []);

    if (!Array.isArray(parsed)) {
      parsed = [];
      try { saveUsers(parsed); } catch (e) {}
    }

    var changed = false;
    for (var i = 0; i < parsed.length; i++) {
      var u = parsed[i] || {};
      if (!u.id) { u.id = "u_" + randHex(12); changed = true; }
      if (typeof u.email !== "string") { u.email = String(u.email || ""); changed = true; }
      if (!u.role) { u.role = "user"; changed = true; }
      if (typeof u.disabled !== "boolean") { u.disabled = false; changed = true; }
      if (typeof u.displayName !== "string") { u.displayName = String(u.displayName || ""); changed = true; }
      if (typeof u.createdAt !== "number") { u.createdAt = u.createdAt ? Number(u.createdAt) : 0; changed = true; }
      // passHash обязателен, но не восстанавливаем (оставим как есть)
      parsed[i] = u;
    }

    if (changed) {
      try { saveUsers(parsed); } catch (e2) {}
    }

    return parsed;
  }

  function usersCount() {
    var users = loadUsers();
    return Array.isArray(users) ? users.length : 0;
  }

  function getUserByEmail(email) {
    email = normalizeEmail(email);
    var users = loadUsers();
    for (var i = 0; i < users.length; i++) {
      if (normalizeEmail(users[i].email) === email) return users[i];
    }
    return null;
  }

  function getUserById(id) {
    var users = loadUsers();
    for (var i = 0; i < users.length; i++) {
      if (users[i].id === id) return users[i];
    }
    return null;
  }

  function isAuthEnabled() {
    return usersCount() > 0;
  }

  // ------------------ session ------------------
  function loadSession() {
    return safeJsonParse(localStorage.getItem(K_SESS) || "null", null);
  }
  function saveSession(sess) {
    localStorage.setItem(K_SESS, safeJsonStringify(sess));
  }
  function clearSession() {
    localStorage.removeItem(K_SESS);
  }

  function ensureSessionValid() {
    var sess = loadSession();
    if (!sess) return null;

    if (sess.expiresAt && nowMs() > sess.expiresAt) {
      clearSession();
      return null;
    }
    return sess;
  }

  function getCurrentUser() {
    var sess = ensureSessionValid();
    if (!sess || !sess.userId) return null;
    return getUserById(sess.userId);
  }

  function startSession(user, rememberDays) {
    rememberDays = Number(rememberDays || 0);
    var ttlMs = rememberDays > 0 ? rememberDays * 24 * 3600 * 1000 : 0;
    var sess = {
      userId: user.id,
      role: user.role,
      createdAt: nowMs(),
      expiresAt: ttlMs ? (nowMs() + ttlMs) : 0
    };
    saveSession(sess);
    return sess;
  }

  function isLoggedIn() {
    return !!getCurrentUser();
  }

  // ------------------ bootstrap admin ------------------
  function generateBootstrapSecrets() {
    return {
      masterKey: "MK-" + randHex(24),
      recoveryCodes: [
        "RC-" + randHex(10),
        "RC-" + randHex(10),
        "RC-" + randHex(10),
        "RC-" + randHex(10),
        "RC-" + randHex(10)
      ]
    };
  }

  // Внутренний создатель пользователя
  function createUserRecord(role, email, password, name) {
    email = normalizeEmail(email);
    if (!email) throw new Error("Email обязателен");

    password = String(password || "");
    if (password.length < 4) throw new Error("Пароль слишком короткий (мин. 4)");

    if (getUserByEmail(email)) throw new Error("Пользователь с таким email уже существует");

    return {
      id: "u_" + randHex(12),
      email: email,
      passHash: hashPass(password),
      role: role,
      displayName: String(name || ""),
      createdAt: nowMs(),
      pinHash: "",
      disabled: false
    };
  }

  // ✅ Совместимость со старым UI:
  // РАНЬШЕ: registerFirstAdmin блокировал регистрацию, если usersCount()>0.
  // ТЕПЕРЬ: это "register" — первый становится admin, остальные user.
  function registerFirstAdmin(email, password, name) {
    var count = usersCount();

    // 1) если это самый первый пользователь -> admin + bootstrap secrets
    if (count === 0) {
      var secrets = generateBootstrapSecrets();

      var adminUser = createUserRecord("admin", email, password, name);

      saveUsers([adminUser]);

      // секреты первого запуска (если где-то выводятся)
      try { localStorage.setItem(K_BOOT, safeJsonStringify(secrets)); } catch (e) {}

      // мастер-ключ: хэш + одноразовый показ (pending)
      try {
        localStorage.setItem(K_MASTER_HASH, hashPass(secrets.masterKey));
        localStorage.setItem(K_MASTER_PENDING, secrets.masterKey);
      } catch (e2) {}

      return { user: adminUser, secrets: secrets };
    }

    // 2) иначе — обычная регистрация USER (НЕ блокируем)
    var users = loadUsers();
    var user = createUserRecord("user", email, password, name);
    users.push(user);
    saveUsers(users);
    return { user: user, secrets: null };
  }

  // Новое имя (если захочешь в будущем перевести login.html на него)
  function registerUser(email, password, name) {
    if (usersCount() === 0) {
      // если случайно вызывают регистрацию юзера на пустой базе — всё равно создаём admin по правилам
      return registerFirstAdmin(email, password, name);
    }
    var users = loadUsers();
    var user = createUserRecord("user", email, password, name);
    users.push(user);
    saveUsers(users);
    return { user: user, secrets: null };
  }

  function readBootstrapSecretsOnce() {
    var raw = localStorage.getItem(K_BOOT);
    if (!raw) return null;
    try { localStorage.removeItem(K_BOOT); } catch (e) {}
    return safeJsonParse(raw, null);
  }

  // ------------------ UI topbar authBox ------------------
  
  // ============================================================
  // DB SCOPE (multi-tenant localStorage)
  // ============================================================
  var ADMIN_VIEW_SCOPE_KEY = "jkh_admin_view_scope_v1"; // device-level, unscoped

  function isGuest() {
    return !getCurrentUser();
  }

  
  // ============================================================
  // CANON FIX (2026-02-01):
  // На страницах reports.html / requisites.html / import_xls.html / new_abonent.html
  // иногда всплывало confirm-сообщение "Гость: только просмотр..." даже у авторизованного USER.
  // Причина: некоторые legacy-скрипты показывают confirm, если на момент вызова они "думают", что роль Guest.
  // Каноническое правило: если пользователь авторизован — НЕ показывать гостевые confirm/alert.
  // ============================================================
  function patchGuestDialogsForLoggedIn() {
    try {
      if (window.__JKH_GUEST_DIALOGS_PATCHED) return;
      window.__JKH_GUEST_DIALOGS_PATCHED = true;

      var origConfirm = window.confirm;
      if (typeof origConfirm === "function") {
        window.confirm = function (msg) {
          try {
            var u = getCurrentUser();
            if (u && typeof msg === "string") {
              // точное подавление только "гостевых" сообщений
              if (msg.indexOf("Гость: только просмотр") !== -1 || msg.indexOf("Войдите, чтобы сохранять") !== -1) {
                return true; // разрешаем действие без всплывашки
              }
            }
          } catch (e) {}
          return origConfirm.apply(window, arguments);
        };
      }

      var origAlert = window.alert;
      if (typeof origAlert === "function") {
        window.alert = function (msg) {
          try {
            var u2 = getCurrentUser();
            if (u2 && typeof msg === "string") {
              if (msg.indexOf("Гость: только просмотр") !== -1 || msg.indexOf("Войдите, чтобы сохранять") !== -1) {
                return; // просто молча подавляем
              }
            }
          } catch (e) {}
          return origAlert.apply(window, arguments);
        };
      }
    } catch (e) {}
  }

function getAdminViewScope() {
    var u = getCurrentUser();
    if (!u || u.role !== "admin") return null;
    try {
      var v = localStorage.getItem(ADMIN_VIEW_SCOPE_KEY);
      if (!v) return u.id;
      return v;
    } catch (e) {
      return u.id;
    }
  }

  function setAdminViewScope(scope) {
    var u = getCurrentUser();
    if (!u || u.role !== "admin") return false;

    // allow "ALL" or конкретный userId
    var ok = false;
    if (scope === "ALL") ok = true;
    else {
      var users = loadUsers();
      for (var i = 0; i < users.length; i++) {
        if (users[i] && users[i].id === scope) { ok = true; break; }
      }
    }
    if (!ok) return false;

    try { localStorage.setItem(ADMIN_VIEW_SCOPE_KEY, scope); } catch (e) {}
    return true;
  }

  function getActiveDbOwnerId() {
    var u = getCurrentUser();
    if (!u) return "guest";
    if (u.role === "admin") {
      return getAdminViewScope() || u.id;
    }
    return u.id;
  }
function renderAuthStatus() {
    var authBox = document.getElementById("authBox");
    if (!authBox) return;

    var u = getCurrentUser();

    if (u) {
      // ✅ всегда показываем EMAIL
      var emailLabel = (u.email || "");

      // ✅ ссылки по роли
      var links = "";
      if (u.role === "admin") {
        links =
          '<a href="admin.html" style="color:blue;text-decoration:underline;font-size:12px;">админка</a>' +
          '<span style="margin:0 6px;">|</span>' +
          '<a href="user_panel.html#statusBox" style="color:blue;text-decoration:underline;font-size:12px;">резервные копии</a>' +
          '<span style="margin:0 6px;">|</span>';
      } else {
        links =
          '<a href="user_panel.html#statusBox" style="color:blue;text-decoration:underline;font-size:12px;">резервные копии</a>' +
          '<span style="margin:0 6px;">|</span>';
      }

      
      // ✅ admin: выбор базы (все / конкретный пользователь)
      var scopeHtml = "";
      var scopeLabelHtml = "";
      if (u.role === "admin") {
        var scope = getAdminViewScope() || u.id;
        var usersList = [];
        try { usersList = adminListUsers() || []; } catch (e) { usersList = []; }

        var opts = [];
        opts.push('<option value="' + u.id + '">база админа</option>');
        opts.push('<option value="ALL">все базы</option>');
        for (var i = 0; i < usersList.length; i++) {
          var uu = usersList[i] || {};
          if (!uu.id || uu.id === u.id) continue;
          var label = (uu.email || uu.id);
          opts.push('<option value="' + uu.id + '">юзер: ' + label + '</option>');
        }

        // ✅ явная метка текущей базы (чтобы не путаться)
        var scopeHuman = (scope === "ALL") ? "все базы (только просмотр)" : (scope === u.id ? "админа" : "юзера");
        scopeLabelHtml = '<span style="font-size:12px;">База: <b>' + scopeHuman + '</b></span>';

        scopeHtml =
          '<select id="adminDbScopeSelect" style="font-size:12px; padding:2px 6px; border:1px solid black;" ' +
          'onchange="(function(v){ if (Auth.setAdminViewScope(v)) { location.reload(); } else { alert(\'Не удалось выбрать базу\'); } })(this.value)">' +
            opts.join('') +
          '</select>';

        // проставим выбранное
        setTimeout(function () {
          try {
            var sel = document.getElementById("adminDbScopeSelect");
            if (sel) sel.value = scope;
          } catch (e) {}
        }, 0);
      }

      authBox.innerHTML = [
        '<div style="display:flex; align-items:center; gap:8px;">',
          links,
          '<span style="font-size:12px;">' + emailLabel + '</span>', scopeLabelHtml, scopeHtml,
          '<button onclick="Auth.logoutAndRedirect()" style="font-size:12px; padding:2px 8px; border:1px solid black; background:white; cursor:pointer;">выйти</button>',
        '</div>'
      ].join("");
    } else {
      authBox.innerHTML = [
        '<a href="login.html" style="color:blue; text-decoration:underline; margin-right:10px;">регистрация</a>',
        '<a href="login.html" style="color:blue; text-decoration:underline;">вход</a>'
      ].join("");
    }
  }

  function logout() {
    clearSession();
    renderAuthStatus();
  }

  function logoutAndRedirect() {
    logout();
    renderAuthStatus();
    var p = window.location.pathname || "";
    if (p.indexOf("admin.html") !== -1) {
      window.location.href = "index.html";
    }
  }

  // Защита страниц
  function protectPages() {
    var path = window.location.pathname || "";
    var protectedNames = ["admin.html", "import_xls.html", "tariffs.html", "requisites.html"];

    var isProtected = false;
    for (var i = 0; i < protectedNames.length; i++) {
      if (path.indexOf(protectedNames[i]) !== -1) { isProtected = true; break; }
    }
    if (!isProtected) return;

    var user = getCurrentUser();
    if (!user) {
      window.location.href = "login.html?redirect=" + encodeURIComponent(window.location.pathname);
      return;
    }

    if (path.indexOf("admin.html") !== -1 && user.role !== "admin") {
      alert("Недостаточно прав для доступа к этой странице");
      window.location.href = "index.html";
    }
  }

  // ------------------ login ------------------
  function loginByPassword(email, password, rememberDays) {
    // BOOTSTRAP: пустая база -> создаём admin автоматически
    if (usersCount() === 0) {
      var created = registerFirstAdmin(email, password, "");
      startSession(created.user, rememberDays);
      renderAuthStatus();
      protectPages();
      return created.user;
    }

    email = normalizeEmail(email);
    password = String(password || "");

    var user = getUserByEmail(email);
    if (!user) throw new Error("Пользователь не найден");
    if (user.disabled) throw new Error("Пользователь заблокирован");
    if (user.passHash !== hashPass(password)) throw new Error("Неверный пароль");

    startSession(user, rememberDays);
    renderAuthStatus();
    protectPages();
    return user;
  }

  function requireRole(role) {
    ensureSessionValid();
    var u = getCurrentUser();
    if (!u) throw new Error("Не выполнен вход");
    if (role && u.role !== role) throw new Error("Недостаточно прав");
    return u;
  }

  function init() {
    patchGuestDialogsForLoggedIn();
    loadUsers(); // нормализация
    ensureSessionValid();
    renderAuthStatus();
    protectPages();

    setInterval(function () {
      ensureSessionValid();
      renderAuthStatus();
    }, 10000);
  }

  // ------------------ ADMIN API (для admin.html) ------------------
  function adminRequire() {
    var u = getCurrentUser();
    if (!u) throw new Error("Требуется вход");
    if (u.role !== "admin") throw new Error("Недостаточно прав");
    return u;
  }

  function adminListUsers() {
    adminRequire();
    var users = loadUsers();
    var out = [];
    for (var i = 0; i < users.length; i++) {
      out.push({
        id: users[i].id,
        email: users[i].email,
        displayName: users[i].displayName || "",
        role: users[i].role || "user",
        disabled: !!users[i].disabled,
        createdAt: users[i].createdAt || 0
      });
    }
    return out;
  }

  function adminCreateUser(payload) {
    adminRequire();

    payload = payload || {};
    var email = normalizeEmail(payload.email);
    var password = String(payload.password || "");
    var displayName = String(payload.displayName || "");
    var role = (payload.role === "admin") ? "admin" : "user";

    if (!email) throw new Error("Email обязателен");
    if (password.length < 4) throw new Error("Пароль слишком короткий (мин. 4)");
    if (getUserByEmail(email)) throw new Error("Пользователь с таким email уже существует");

    var users = loadUsers();
    users.push({
      id: "u_" + randHex(12),
      email: email,
      passHash: hashPass(password),
      role: role,
      displayName: displayName,
      createdAt: nowMs(),
      pinHash: "",
      disabled: false
    });
    saveUsers(users);
    return true;
  }

  function adminSetDisabled(userId, disabled) {
    adminRequire();
    var users = loadUsers();
    var found = false;

    for (var i = 0; i < users.length; i++) {
      if (users[i].id === userId) {
        users[i].disabled = !!disabled;
        found = true;
        break;
      }
    }
    if (!found) throw new Error("Пользователь не найден");

    saveUsers(users);

    var cur = getCurrentUser();
    if (cur && cur.id === userId && !!disabled) {
      clearSession();
    }
    return true;
  }

  function adminResetPassword(userId, newPass) {
    adminRequire();
    newPass = String(newPass || "");
    if (newPass.length < 4) throw new Error("Пароль слишком короткий (мин. 4)");

    var users = loadUsers();
    var found = false;

    for (var i = 0; i < users.length; i++) {
      if (users[i].id === userId) {
        users[i].passHash = hashPass(newPass);
        found = true;
        break;
      }
    }
    if (!found) throw new Error("Пользователь не найден");

    saveUsers(users);
    return true;
  }

  function adminRotateMasterKey() {
    adminRequire();
    var key = "MK-" + randHex(24);
    try {
      localStorage.setItem(K_MASTER_HASH, hashPass(key));
      localStorage.setItem(K_MASTER_PENDING, key);
    } catch (e) {}
    return true;
  }

  function popMasterKeyOnce() {
    var key = localStorage.getItem(K_MASTER_PENDING) || "";
    if (key) {
      try { localStorage.removeItem(K_MASTER_PENDING); } catch (e) {}
      return key;
    }
    return "";
  }

  function adminDeleteUser(userId){
    adminRequire();

    var me = getCurrentUser();
    if (me && me.id === userId){
      throw new Error("Нельзя удалить самого себя");
    }

    var users = loadUsers();
    var admins = users.filter(function(u){ return u.role === "admin" && !u.disabled; });
    if (admins.length <= 1){
      throw new Error("Нельзя удалить последнего администратора");
    }

    var idx = -1;
    for (var i = 0; i < users.length; i++){
      if (users[i].id === userId){ idx = i; break; }
    }
    if (idx === -1) throw new Error("Пользователь не найден");

    users.splice(idx, 1);
    saveUsers(users);
    return true;
  }

  // ------------------ backup snapshot (localStorage) ------------------
  function exportProjectStorageSnapshot() {
    adminRequire();

    var snap = {
      _meta: {
        format: "papajkh_localstorage_snapshot_v1",
        createdAt: nowMs()
      },
      keys: {}
    };

    for (var i = 0; i < localStorage.length; i++) {
      var k = localStorage.key(i);
      if (k === K_BOOT) continue;
      if (k === K_MASTER_PENDING) continue;
      snap.keys[k] = localStorage.getItem(k);
    }
    return snap;
  }

  function importProjectStorageSnapshot(obj) {
    adminRequire();
    if (!obj || !obj.keys || typeof obj.keys !== "object") {
      throw new Error("Неверный формат резервной копии");
    }

    localStorage.clear();
    var keys = obj.keys;
    for (var k in keys) {
      if (Object.prototype.hasOwnProperty.call(keys, k)) {
        localStorage.setItem(k, keys[k]);
      }
    }
    return true;
  }

  // ------------------ Promise wrappers ------------------
  function pwrap(fn) {
    return function () {
      var args = arguments;
      return Promise.resolve().then(function(){ return fn.apply(null, args); });
    };
  }

  // ------------------ exports ------------------
  window.Auth = {
    // base
    isAuthEnabled: isAuthEnabled,
    authEnabled: isAuthEnabled,
    isLoggedIn: isLoggedIn,

    getCurrentUser: getCurrentUser,
    getSessionUser: pwrap(function(){ return getCurrentUser(); }), // admin.html ждёт это

    ensureSessionValid: ensureSessionValid,
    logout: logout,
    logoutAndRedirect: logoutAndRedirect,
    requireRole: requireRole,
    readBootstrapSecretsOnce: readBootstrapSecretsOnce,

    init: init,
    renderAuthStatus: renderAuthStatus,
    protectPages: protectPages,

    // login
    loginByPassword: pwrap(loginByPassword),

    // ✅ совместимость со старым UI (кнопка "регистрация" могла вызывать registerFirstAdmin)
    registerFirstAdmin: pwrap(registerFirstAdmin),

    // ✅ новый явный метод (можно позже перевести login.html на него)
    registerUser: pwrap(registerUser),

    // alias
    signIn: function(email, password, rememberDays) {
      return this.loginByPassword(email, password, rememberDays);
    },

    // admin api
    adminListUsers: pwrap(adminListUsers),
    adminCreateUser: pwrap(adminCreateUser),
    adminSetDisabled: pwrap(adminSetDisabled),
    adminResetPassword: pwrap(adminResetPassword),
    adminDeleteUser: pwrap(adminDeleteUser),
    adminRotateMasterKey: pwrap(adminRotateMasterKey),
    popMasterKeyOnce: popMasterKeyOnce,

    // db scope
    isGuest: isGuest,
    getAdminViewScope: getAdminViewScope,
    setAdminViewScope: setAdminViewScope,
    getActiveDbOwnerId: getActiveDbOwnerId,

    // backup
    exportProjectStorageSnapshot: exportProjectStorageSnapshot,
    importProjectStorageSnapshot: importProjectStorageSnapshot
  };
})();
