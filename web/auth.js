/* ============================================================
   auth.js — OFFLINE-FIRST вход/пользователи/админка (v1)
   - Без ES-modules (должно работать file://)
   - Без сервера / без email
   - Первый запуск: регистрация первого пользователя (ADMIN)
   - После создания пользователей: защита страниц (кроме login.html)
   - Админка: admin.html (после входа)

   ВАЖНО:
   - Не ломаем существующую логику расчётов.
   - Не трогаем calc_engine / payment_table / spravka_*.
   - Работаем только через localStorage.

   Профили пользователей:
   - Мы храним «снимок базы проекта» для каждого пользователя.
   - При входе переключаем активную базу на профиль пользователя.

   (c) ПРОЕКТ ПАПАЖКХ
   ============================================================ */

(function () {
  "use strict";

  // ============================================================
  // KEYS
  // ============================================================
  const AUTH_USERS_KEY = "auth_users_v1";
  const AUTH_SESSION_KEY = "auth_session_v1";
  const AUTH_MASTER_KEY_HASH = "auth_master_key_hash_v1";
  const AUTH_PROFILE_PREFIX = "auth_profile_"; // + userId
  const AUTH_SETTINGS_KEY = "auth_settings_v1";
  const AUTH_LAST_EMAIL_KEY = "auth_last_email_v1";

  // Проектные ключи (whitelist для backup/restore)
  // (дублируем список из data.js — НЕ ТРОГАЯ data.js)
  const PROJECT_KEY_PREFIXES = [
    "payments_",
    "note_",
    "exclude_periods_",
    "calc_period_",
    "calc_period_active_",
    "report_period_",
    "payments_ui_collapsed_"
  ];
  const PROJECT_KEY_EXACT = [
    "abonents_db_v1",
    "abonent_notes_v1",
    "exclude_periods_v1",
    "tariffs_v1",
    "refinancing_v1",
    "import_preview_v1",
    "draft_new_abonent_v1",
    "payment_sources_v1",
    "tariffs_content_repair_v1",
    "tariffs_content_repair_v1_backup",
    "refinancing_rates_normal_v1",
    "refinancing_rates_moratorium_v1",
    "jkh_excel_date_debug",
    "last_abonent_id"
  ];

  // Пустая база (дублируем BASE_DB из data.js)
  const EMPTY_DB = {
    orgName: 'ТСЖ "Карла Маркса 50"',
    orgInn: "4909093352",
    chairman: "В.Б.Тремов",
    premises: {},
    links: [],
    abonents: {}
  };

  // ============================================================
  // UTILS
  // ============================================================
  function nowIso() {
    try { return new Date().toISOString(); } catch { return ""; }
  }

  function safeJsonParse(raw, fallback) {
    try {
      if (!raw) return fallback;
      const v = JSON.parse(raw);
      return v === undefined ? fallback : v;
    } catch {
      return fallback;
    }
  }

  function safeJsonStringify(obj) {
    try { return JSON.stringify(obj); } catch { return ""; }
  }

  function uid() {
    return "u_" + Math.random().toString(36).slice(2) + Date.now().toString(36);
  }

  function normalizeEmail(e) {
    return String(e || "").trim().toLowerCase();
  }

  function getPath() {
    try {
      const p = (location.pathname || "").split("/");
      return (p[p.length - 1] || "").toLowerCase();
    } catch {
      return "";
    }
  }

  function isLoginPage() {
    const p = getPath();
    return p === "login.html";
  }

  function isAdminPage() {
    const p = getPath();
    return p === "admin.html";
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  // ============================================================
  // HASHING (лучше crypto.subtle, fallback — простой hash)
  // ============================================================
  function toHex(buffer) {
    const bytes = new Uint8Array(buffer);
    let out = "";
    for (let i = 0; i < bytes.length; i++) {
      out += bytes[i].toString(16).padStart(2, "0");
    }
    return out;
  }

  // FNV-1a 32-bit (fallback, не крипто)
  function fnv1a32(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return ("00000000" + h.toString(16)).slice(-8);
  }

  async function sha256(str) {
    str = String(str);
    try {
      if (window.crypto && window.crypto.subtle && window.TextEncoder) {
        const data = new TextEncoder().encode(str);
        const digest = await crypto.subtle.digest("SHA-256", data);
        return toHex(digest);
      }
    } catch {
      // ignore
    }
    // fallback
    return "fnv1a:" + fnv1a32(str);
  }

  // ============================================================
  // STORAGE: USERS / SESSION
  // ============================================================
  function loadUsers() {
    return safeJsonParse(localStorage.getItem(AUTH_USERS_KEY), { users: [] });
  }

  function saveUsers(db) {
    localStorage.setItem(AUTH_USERS_KEY, safeJsonStringify(db));
  }

  function getUsersList() {
    const db = loadUsers();
    return Array.isArray(db.users) ? db.users : [];
  }

  function findUserByEmail(email) {
    const e = normalizeEmail(email);
    return getUsersList().find((u) => normalizeEmail(u.email) === e) || null;
  }

  function findUserById(id) {
    return getUsersList().find((u) => u.id === id) || null;
  }

  function isAuthEnabled() {
    return getUsersList().length > 0;
  }

  // Backward-compat alias: часть страниц/версий используют Auth.authEnabled()
  function authEnabled() {
    return isAuthEnabled();
  }

  function setLastEmail(email) {
    try {
      const e = normalizeEmail(email);
      if (e) localStorage.setItem(AUTH_LAST_EMAIL_KEY, e);
    } catch {
      // ignore
    }
  }

  function getLastEmail() {
    try {
      return String(localStorage.getItem(AUTH_LAST_EMAIL_KEY) || "").trim();
    } catch {
      return "";
    }
  }

  function loadSession() {
    const s = safeJsonParse(localStorage.getItem(AUTH_SESSION_KEY), null);
    if (!s || !s.userId) return null;
    // rememberUntil
    if (s.rememberUntil) {
      try {
        if (Date.now() > Number(s.rememberUntil)) {
          localStorage.removeItem(AUTH_SESSION_KEY);
          return null;
        }
      } catch {
        // ignore
      }
    }
    return s;
  }

  function saveSession(session) {
    localStorage.setItem(AUTH_SESSION_KEY, safeJsonStringify(session));
  }

  function clearSession() {
    localStorage.removeItem(AUTH_SESSION_KEY);
  }

  function getCurrentUser() {
    const s = loadSession();
    if (!s) return null;
    const u = findUserById(s.userId);
    if (!u || u.disabled) return null;
    return u;
  }

  // Совместимость: некоторые страницы ожидают isLoggedIn()
  function isLoggedIn() {
    return !!getCurrentUser();
  }

  // Совместимость с UI старых страниц
  function getSessionUser() {
    return getCurrentUser();
  }

  // ============================================================
  // MASTER KEY (для аварийного сброса)
  // ============================================================
  async function ensureMasterKeyHashExists() {
    if (localStorage.getItem(AUTH_MASTER_KEY_HASH)) return;
    const mk = generateMasterKey();
    const h = await sha256(mk);
    localStorage.setItem(AUTH_MASTER_KEY_HASH, h);
    // показываем 1 раз при первом создании пользователей
    localStorage.setItem("auth_master_key_once_v1", mk);
  }

  function generateMasterKey() {
    // человеческий формат: 4 блока по 4 символа
    const abc = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    function block() {
      let b = "";
      for (let i = 0; i < 4; i++) b += abc[Math.floor(Math.random() * abc.length)];
      return b;
    }
    return [block(), block(), block(), block()].join("-");
  }

  async function verifyMasterKey(masterKey) {
    const stored = localStorage.getItem(AUTH_MASTER_KEY_HASH);
    if (!stored) return false;
    const h = await sha256(String(masterKey || "").trim());
    return h === stored;
  }

  function popMasterKeyOnce() {
    const mk = localStorage.getItem("auth_master_key_once_v1");
    if (mk) localStorage.removeItem("auth_master_key_once_v1");
    return mk || "";
  }

  function readBootstrapSecretsOnce() {
    // возвращает {masterKey, recoveryCodes} и очищает
    const raw = localStorage.getItem("auth_bootstrap_secrets_v1");
    if (!raw) return null;
    try { localStorage.removeItem("auth_bootstrap_secrets_v1"); } catch {}
    return safeJsonParse(raw, null);
  }


  // ============================================================
  // PROJECT BACKUP / RESTORE
  // ============================================================
  function shouldIncludeProjectKey(k) {
    if (PROJECT_KEY_EXACT.includes(k)) return true;
    return PROJECT_KEY_PREFIXES.some((p) => k.startsWith(p));
  }

  function exportProjectStorageSnapshot() {
    const storage = {};
    Object.keys(localStorage).forEach((k) => {
      if (!shouldIncludeProjectKey(k)) return;
      storage[k] = localStorage.getItem(k);
    });
    return {
      app: "PAPAJKH",
      schema_version: "1.5.3",
      exported_at: nowIso(),
      storage
    };
  }

  function removeProjectKeys() {
    PROJECT_KEY_EXACT.forEach((k) => localStorage.removeItem(k));
    Object.keys(localStorage).forEach((k) => {
      if (PROJECT_KEY_PREFIXES.some((p) => k.startsWith(p))) localStorage.removeItem(k);
    });
    try { sessionStorage.clear(); } catch { /* ignore */ }
  }

  function importProjectStorageSnapshot(backupObj) {
    if (!backupObj || backupObj.app !== "PAPAJKH" || typeof backupObj.storage !== "object") {
      throw new Error("Неверный формат бэкапа");
    }

    // очистим текущие проектные ключи
    removeProjectKeys();

    // запишем строго whitelist-ключи
    Object.keys(backupObj.storage).forEach((k) => {
      if (!shouldIncludeProjectKey(k)) return;
      const v = backupObj.storage[k];
      if (v === null || v === undefined) return;
      localStorage.setItem(k, String(v));
    });

    // гарантируем, что база существует
    if (!localStorage.getItem("abonents_db_v1")) {
      localStorage.setItem("abonents_db_v1", safeJsonStringify(EMPTY_DB));
    }
  }

  // ============================================================
  // USER BACKUP (для user_panel.html)
  // ============================================================
  function exportUserBackup() {
    const u = getCurrentUser();
    if (!u) throw new Error("Нужен вход");
    const snap = exportProjectStorageSnapshot();
    return {
      type: "PAPAJKH_USER_BACKUP",
      exported_at: snap.exported_at,
      schema_version: snap.schema_version,
      owner: { id: u.id, email: u.email, role: u.role },
      snapshot: snap
    };
  }

  function importUserBackup(obj) {
    const u = getCurrentUser();
    if (!u) throw new Error("Нужен вход");
    if (!obj || obj.type !== "PAPAJKH_USER_BACKUP" || !obj.snapshot) {
      throw new Error("Неверный формат бэкапа");
    }
    // CRITICAL: обычный пользователь не может импортировать чужой бэкап
    if (u.role !== "admin" && obj.owner && obj.owner.id && obj.owner.id !== u.id) {
      throw new Error("Этот бэкап принадлежит другому пользователю");
    }
    importProjectStorageSnapshot(obj.snapshot);
    // сразу фиксируем профиль в хранилище (не ждём logout)
    try { saveProfileSnapshotForUser(u.id); } catch { /* ignore */ }
  }

  function saveCurrentProfileNow() {
    const u = getCurrentUser();
    if (!u) throw new Error("Нужен вход");
    try { saveProfileSnapshotForUser(u.id); } catch { /* ignore */ }
    return true;
  }

  // ============================================================
  // USER PROFILES (снимок проектной базы на пользователя)
  // ============================================================
  function getProfileKey(userId) {
    return AUTH_PROFILE_PREFIX + userId;
  }

  function saveProfileSnapshotForUser(userId) {
    const snap = exportProjectStorageSnapshot();
    localStorage.setItem(getProfileKey(userId), safeJsonStringify(snap));
  }

  function hasProfileSnapshot(userId) {
    return !!localStorage.getItem(getProfileKey(userId));
  }

  function loadProfileSnapshot(userId) {
    return safeJsonParse(localStorage.getItem(getProfileKey(userId)), null);
  }

  function initEmptyProjectStorage() {
    removeProjectKeys();
    localStorage.setItem("abonents_db_v1", safeJsonStringify(EMPTY_DB));
    // минимальные справочники можно добавить позже, сейчас не трогаем
  }

  // ============================================================
  // AUTH FLOWS
  // ============================================================
  async function createUser({ email, password, role, displayName }) {
    const e = normalizeEmail(email);
    if (!e) throw new Error("Введите email");
    if (!password || String(password).length < 6) throw new Error("Пароль минимум 6 символов");

    const usersDb = loadUsers();
    usersDb.users = Array.isArray(usersDb.users) ? usersDb.users : [];

    if (usersDb.users.some((u) => normalizeEmail(u.email) === e)) {
      throw new Error("Пользователь с таким email уже существует");
    }

    await ensureMasterKeyHashExists();

    const passHash = await sha256(password);

    const user = {
      id: uid(),
      email: e,
      role: role || "user",
      displayName: String(displayName || "").trim(),
      passHash,
      pinHash: "",
      recovery: [],
      disabled: false,
      createdAt: nowIso()
    };

    usersDb.users.push(user);
    saveUsers(usersDb);

    return user;
  }

  // ============================================================
  // FIRST ADMIN (bootstrap)
  // ============================================================
  async function registerFirstAdmin(email, password, name) {
    if (isAuthEnabled()) {
      throw new Error("Регистрация первого администратора уже выполнена");
    }
    const user = await createUser({ email, password, role: "admin", displayName: name || "" });

    // Первому админу сразу выдаём мастер-ключ и recovery-коды (показываем один раз)
    const recoveryCodes = await generateRecoveryCodes(user.id);
    const masterKey = popMasterKeyOnce();

    return {
      user,
      secrets: {
        masterKey: masterKey || "",
        recoveryCodes: Array.isArray(recoveryCodes) ? recoveryCodes : []
      }
    };
  }

  async function setUserPin(userId, pin) {
    pin = String(pin || "").trim();
    if (!/^\d{4,8}$/.test(pin)) throw new Error("PIN должен быть 4–8 цифр");

    const usersDb = loadUsers();
    const u = (usersDb.users || []).find((x) => x.id === userId);
    if (!u) throw new Error("Пользователь не найден");

    u.pinHash = await sha256("PIN:" + pin);
    saveUsers(usersDb);
  }

  async function generateRecoveryCodes(userId) {
    const usersDb = loadUsers();
    const u = (usersDb.users || []).find((x) => x.id === userId);
    if (!u) throw new Error("Пользователь не найден");

    const codes = [];
    const abc = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    for (let i = 0; i < 10; i++) {
      let c = "";
      for (let j = 0; j < 10; j++) c += abc[Math.floor(Math.random() * abc.length)];
      codes.push(c);
    }

    u.recovery = [];
    for (const c of codes) u.recovery.push(await sha256("RC:" + c));
    saveUsers(usersDb);

    return codes;
  }

  async function loginByPassword(email, password, rememberDays) {
    // ✅ BOOTSTRAP: если пользователей ещё нет — первый вход создаёт ADMIN и сразу логинит.
    if (!isAuthEnabled()) {
      const created = await registerFirstAdmin(email, password, "");
      // сохраняем секреты (мастер-ключ и recovery-коды) в localStorage для разового просмотра
      try { localStorage.setItem("auth_bootstrap_secrets_v1", safeJsonStringify(created.secrets || {})); } catch {}
      // UX: запоминаем последний email
      setLastEmail(email);
      await startSession(created.user, rememberDays);
      return created.user;
    }


    const u = findUserByEmail(email);
    if (!u) throw new Error("Пользователь не найден");
    if (u.disabled) throw new Error("Пользователь заблокирован");

    const h = await sha256(password);
    if (h !== u.passHash) throw new Error("Неверный пароль");

    // UX: запоминаем последний email (для автоподстановки на login.html)
    setLastEmail(email);

    await startSession(u, rememberDays);
    return u;
  }

  async function loginByPin(email, pin, rememberDays) {
    const u = findUserByEmail(email);
    if (!u) throw new Error("Пользователь не найден");
    if (u.disabled) throw new Error("Пользователь заблокирован");
    if (!u.pinHash) throw new Error("PIN не настроен");

    const h = await sha256("PIN:" + String(pin || "").trim());
    if (h !== u.pinHash) throw new Error("Неверный PIN");

    // UX: запоминаем последний email
    setLastEmail(email);

    await startSession(u, rememberDays);
    return u;
  }

  // Alias for UI: Auth.signIn(email, password, rememberDays)
  async function signIn(email, password, rememberDays) {
    return loginByPassword(email, password, rememberDays);
  }

  async function consumeRecoveryCode(email, code) {
    const u = findUserByEmail(email);
    if (!u) throw new Error("Пользователь не найден");
    if (u.disabled) throw new Error("Пользователь заблокирован");

    const codeHash = await sha256("RC:" + String(code || "").trim().toUpperCase());

    const usersDb = loadUsers();
    const uu = (usersDb.users || []).find((x) => x.id === u.id);
    if (!uu) throw new Error("Пользователь не найден");

    const idx = (uu.recovery || []).indexOf(codeHash);
    if (idx < 0) throw new Error("Неверный recovery-код");

    // одноразовый код — удаляем
    uu.recovery.splice(idx, 1);
    saveUsers(usersDb);

    return uu;
  }

  async function resetPasswordDirect(email, newPassword) {
    if (!newPassword || String(newPassword).length < 6) throw new Error("Пароль минимум 6 символов");

    const usersDb = loadUsers();
    const u = (usersDb.users || []).find((x) => normalizeEmail(x.email) === normalizeEmail(email));
    if (!u) throw new Error("Пользователь не найден");

    u.passHash = await sha256(newPassword);
    // при сбросе пароля сбрасываем pin (чтобы не осталось старого быстрого доступа)
    u.pinHash = "";

    saveUsers(usersDb);

    // после смены пароля лучше разлогинить активную сессию
    const s = loadSession();
    if (s && s.userId === u.id) clearSession();

    return true;
  }

  // Совместимость с UI: resetPassword(email, newPassword, {type:'recovery', code} | {type:'master', key})
  async function resetPassword(email, newPassword, proof) {
    if (proof && typeof proof === 'object' && proof.type) {
      if (proof.type === 'recovery') {
        await consumeRecoveryCode(email, proof.code);
        return resetPasswordDirect(email, newPassword);
      }
      if (proof.type === 'master') {
        const ok = await verifyMasterKey(proof.key);
        if (!ok) throw new Error('Неверный мастер-ключ');
        return resetPasswordDirect(email, newPassword);
      }
      throw new Error('Неизвестный способ восстановления');
    }
    // старый вызов: resetPassword(email, newPassword)
    return resetPasswordDirect(email, newPassword);
  }

  async function startSession(user, rememberDays) {
    // Перед переключением базы — сохраняем профиль предыдущей сессии
    const prev = loadSession();
    if (prev && prev.userId && prev.userId !== user.id) {
      try { saveProfileSnapshotForUser(prev.userId); } catch { /* ignore */ }
    }

    // Переключение базы на профиль пользователя
    if (hasProfileSnapshot(user.id)) {
      const snap = loadProfileSnapshot(user.id);
      if (snap) {
        try { importProjectStorageSnapshot(snap); } catch { /* ignore */ }
      }
    } else {
      // Если профиля нет:
      // - Если это самый первый пользователь (bootstrap) — НЕ трогаем текущую базу, а сохраняем её как его профиль
      // - Иначе — стартуем с пустой базы
      const usersCount = getUsersList().length;
      if (usersCount === 1 && user.role === "admin") {
        try { saveProfileSnapshotForUser(user.id); } catch { /* ignore */ }
      } else {
        initEmptyProjectStorage();
        try { saveProfileSnapshotForUser(user.id); } catch { /* ignore */ }
      }
    }

    const sess = {
      userId: user.id,
      createdAt: nowIso(),
      token: uid()
    };
    const days = Number(rememberDays || 0);
    if (days > 0) {
      sess.rememberUntil = String(Date.now() + days * 24 * 60 * 60 * 1000);
    }
    saveSession(sess);

    // чтобы текущая вкладка увидела новую базу
    try { location.reload(); } catch { /* ignore */ }
  }

  function logout() {
    const u = getCurrentUser();
    if (u) {
      try { saveProfileSnapshotForUser(u.id); } catch { /* ignore */ }
    }
    clearSession();
    try { location.href = "login.html"; } catch { /* ignore */ }
  }

  // ============================================================
  // GUARD / UI
  // ============================================================
  function renderAuthBox() {
    const box = document.getElementById("authBox") || document.querySelector(".login-box");
    if (!box) return;

    const enabled = isAuthEnabled();
    const user = getCurrentUser();

    if (!enabled) {
      box.innerHTML = `<a href="login.html" style="text-decoration:none;">настроить вход</a>`;
      return;
    }

    if (!user) {
      box.innerHTML = `<a href="login.html" style="text-decoration:none;">войти</a>`;
      return;
    }

    const safeEmail = String(user.email || "");
    const isAdmin = user.role === "admin";

    box.innerHTML = `
      <span style="white-space:nowrap;">${safeEmail}</span>
      <span style="margin:0 6px;">|</span>
      <a href="user_panel.html" style="text-decoration:none;">резервные копии</a>
      <span style="margin:0 6px;">|</span>
      ${isAdmin ? `<a href="admin.html" style="text-decoration:none;">админка</a><span style="margin:0 6px;">|</span>` : ``}
      <a href="#" id="authLogoutLink" style="text-decoration:none;">выход</a>
    `;
    
    const link = document.getElementById("authLogoutLink");
    if (link) {
      link.addEventListener("click", (e) => {
        e.preventDefault();
        logout();
      });
    }
  }

  function guardPages() {
    if (!isAuthEnabled()) return; // до настройки — не блокируем
    if (isLoginPage()) return;

    const u = getCurrentUser();
    if (!u) {
      try { location.href = "login.html"; } catch { /* ignore */ }
      return;
    }

    if (isAdminPage() && u.role !== "admin") {
      alert("Доступ запрещён: нужна роль ADMIN");
      try { location.href = "index.html"; } catch { /* ignore */ }
    }
  }

  // ============================================================
  // ADMIN API (для admin.html)
  // ============================================================
  // Совместимость: admin.html может передавать объект {email, password, role, displayName}
  async function adminCreateUser(email, password, role) {
    const me = getCurrentUser();
    if (!me || me.role !== "admin") throw new Error("Требуется ADMIN");

    let payload;
    if (email && typeof email === 'object') {
      payload = {
        email: email.email,
        password: email.password,
        role: email.role,
        displayName: email.displayName
      };
    } else {
      payload = { email, password, role: role || 'user', displayName: '' };
    }

    const u = await createUser(payload);
    // для нового пользователя создадим пустой профиль
    if (!hasProfileSnapshot(u.id)) {
      initEmptyProjectStorage();
      saveProfileSnapshotForUser(u.id);
      // вернём базу обратно админу
      if (hasProfileSnapshot(me.id)) {
        const snap = loadProfileSnapshot(me.id);
        if (snap) importProjectStorageSnapshot(snap);
      }
    }
    return u;
  }

  function adminListUsers() {
    const me = getCurrentUser();
    if (!me || me.role !== "admin") throw new Error("Требуется ADMIN");
    return getUsersList().map((u) => ({
      id: u.id,
      email: u.email,
      displayName: u.displayName || "",
      role: u.role,
      disabled: !!u.disabled,
      createdAt: u.createdAt || ""
    }));
  }

  function adminSetDisabled(userId, disabled) {
    const me = getCurrentUser();
    if (!me || me.role !== "admin") throw new Error("Требуется ADMIN");

    const usersDb = loadUsers();
    const u = (usersDb.users || []).find((x) => x.id === userId);
    if (!u) throw new Error("Пользователь не найден");
    if (u.id === me.id) throw new Error("Нельзя блокировать самого себя");

    u.disabled = !!disabled;
    saveUsers(usersDb);
  }

  async function adminResetPassword(userId, newPassword) {
    const me = getCurrentUser();
    if (!me || me.role !== "admin") throw new Error("Требуется ADMIN");

    const usersDb = loadUsers();
    const u = (usersDb.users || []).find((x) => x.id === userId);
    if (!u) throw new Error("Пользователь не найден");

    if (!newPassword || String(newPassword).length < 6) throw new Error("Пароль минимум 6 символов");
    u.passHash = await sha256(newPassword);
    u.pinHash = "";
    saveUsers(usersDb);

    return true;
  }

  async function adminRotateMasterKey() {
    const me = getCurrentUser();
    if (!me || me.role !== "admin") throw new Error("Требуется ADMIN");

    const mk = generateMasterKey();
    const h = await sha256(mk);
    localStorage.setItem(AUTH_MASTER_KEY_HASH, h);
    localStorage.setItem("auth_master_key_once_v1", mk);
    return mk;
  }

  // ============================================================
  // INIT
  // ============================================================
  async function init() {
    try {
      // 1) Guard pages
      guardPages();
      // 2) Render auth box
      renderAuthBox();
    } catch {
      // ignore
    }
  }

  // ============================================================
  // PUBLIC API
  // ============================================================
  window.Auth = {
    // base
    init,
    isAuthEnabled,
    authEnabled,
    isLoggedIn,
    getSessionUser,
    getCurrentUser,
    logout,

    // UX helpers
    getLastEmail,
    setLastEmail,

    // login/register
    loginByPassword,
    loginByPin,
    signIn,
    createUser,
    registerFirstAdmin,
    setUserPin,
    generateRecoveryCodes,
    consumeRecoveryCode,
    resetPassword,
    verifyMasterKey,
    popMasterKeyOnce,
    readBootstrapSecretsOnce,

    // backup
    exportProjectStorageSnapshot,
    importProjectStorageSnapshot,
    exportUserBackup,
    importUserBackup,
    saveCurrentProfileNow,

    // admin
    adminCreateUser,
    adminListUsers,
    adminSetDisabled,
    adminResetPassword,
    adminRotateMasterKey
  };

})();
