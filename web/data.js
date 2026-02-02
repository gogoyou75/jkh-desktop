// data.js — база абонентов (пустая по умолчанию) + ДЕМО 1006/1008 по кнопке
// Полная новая версия под "загрузить демо" (регрессионный стенд)

(function () {
  "use strict";

  // ============================================================
  // CONFIG
  // ============================================================
  const KEY_DB = "abonents_db_v1";

  // ============================================================
  // Scoped storage helpers (per-user базы + admin "ALL")
  // ============================================================
  function _ownerId() {
    try {
      if (window.Auth && typeof Auth.getActiveDbOwnerId === "function") return Auth.getActiveDbOwnerId();
      if (window.JKHStorage && typeof JKHStorage.getActiveOwnerId === "function") return JKHStorage.getActiveOwnerId();
    } catch (e) {}
    return "guest";
  }

  function _isAllMode() { return _ownerId() === "ALL"; }

  function _isGuest() {
    try {
      if (window.Auth && typeof Auth.isGuest === "function") return Auth.isGuest();
    } catch (e) {}
    return _ownerId() === "guest";
  }

  function _canWriteStorage() {
    return !_isGuest() && !_isAllMode();
  }

  function _explainWriteBlocked() {
    if (_isGuest()) {
      alert("Гость: только просмотр. Войдите, чтобы сохранять.");
      return;
    }
    if (_isAllMode()) {
      alert("Режим 'все базы' — только просмотр. Выберите конкретную базу в выпадающем списке (админ).");
    }
  }

  function canWriteOrExplain() {
    if (_canWriteStorage()) return true;
    _explainWriteBlocked();
    return false;
  }

  function _k(key, ownerId) {
    try {
      if (window.JKHStorage && typeof JKHStorage.k === "function") return JKHStorage.k(key, ownerId);
    } catch (e) {}
    return "jkhdb::" + String(ownerId || _ownerId()) + "::" + key;
  }


  // Список ключей/префиксов проекта для "сброс базы" и "загрузить демо"
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
    KEY_DB,
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

  // ============================================================
  // HELPERS
  // ============================================================
  function deepClone(obj) {
    return JSON.parse(JSON.stringify(obj));
  }
  function isPlainObject(x) {
    return x && typeof x === "object" && !Array.isArray(x);
  }

  function safeJsonParse(raw, fallback) {
    try {
      if (!raw) return fallback;
      const v = JSON.parse(raw);
      return v === undefined ? fallback : v;
    } catch (e) {
      return fallback;
    }
  }

  function removeProjectKeys() {
    // ВАЖНО: сброс делаем в рамках выбранной базы (scoped).
    // admin в режиме "ALL" — сбрасывает ВСЕ пользовательские базы.
    var owners = [];
    if (_isAllMode()) {
      try {
        var users = (window.Auth && typeof Auth.adminListUsers === "function") ? Auth.adminListUsers() : [];
        if (Array.isArray(users)) {
          for (var i = 0; i < users.length; i++) if (users[i] && users[i].id) owners.push(users[i].id);
        }
      } catch (e) {}
    } else {
      owners = [_ownerId()];
    }

    for (var oi = 0; oi < owners.length; oi++) {
      var owner = owners[oi];

      // exact keys
      for (var ei = 0; ei < PROJECT_KEY_EXACT.length; ei++) {
        var ek = PROJECT_KEY_EXACT[ei];
        try { localStorage.removeItem(_k(ek, owner)); } catch (e) {}
      }

      // prefixes (scoped)
      var pref = (window.JKHStorage && typeof JKHStorage.scopePrefixFor === "function")
        ? JKHStorage.scopePrefixFor(owner)
        : ("jkhdb::" + String(owner) + "::");

      for (var li = localStorage.length - 1; li >= 0; li--) {
        var kk = localStorage.key(li);
        if (!kk) continue;
        if (kk.indexOf(pref) !== 0) continue;
        var tail = kk.slice(pref.length);
        for (var pi = 0; pi < PROJECT_KEY_PREFIXES.length; pi++) {
          if (tail.indexOf(PROJECT_KEY_PREFIXES[pi]) === 0) { try { localStorage.removeItem(kk); } catch (e) {} break; }
        }
      }
    }

    // sessionStorage можно чистить, но НЕ трогаем Auth-сессию намеренно.
    // (логин/выбор базы остаются)
    try { sessionStorage.clear(); } catch (e) {}
  }// ============================================================
  // AbonentsDB base (пустая структура)
  // ============================================================
  const BASE_DB = {
    orgName: 'ТСЖ "Карла Маркса 50"',
    orgInn: "4909093352",
    chairman: "В.Б.Тремов",

    // новая структура
    premises: {},   // {regnum: {regnum, city, street, house, flat, square, createdAt}}
    links: [],      // [{abonentId, regnum, dateFrom, dateTo}]

    // абоненты
    abonents: {}    // {id: {...}}
  };

  function mergePreferStored(baseDb, storedDb) {
    const out = deepClone(baseDb);

    if (isPlainObject(storedDb)) {
      ["orgName", "orgInn", "chairman"].forEach((k) => {
        if (storedDb[k] !== undefined && storedDb[k] !== null) out[k] = storedDb[k];
      });

      if (isPlainObject(storedDb.abonents)) {
        out.abonents = out.abonents || {};
        Object.keys(storedDb.abonents).forEach((id) => {
          out.abonents[id] = storedDb.abonents[id];
        });
      }

      if (isPlainObject(storedDb.premises)) {
        out.premises = out.premises || {};
        Object.keys(storedDb.premises).forEach((regnum) => {
          out.premises[regnum] = storedDb.premises[regnum];
        });
      }

      if (Array.isArray(storedDb.links)) out.links = storedDb.links;
    }

    return out;
  }

  function loadFromStorage() {
    // admin ALL-mode: объединённый просмотр всех баз (READONLY)
    if (_isAllMode()) {
      var merged = { version: 1, premises: {}, links: [], abonents: {} };
      try {
        var users = (window.Auth && typeof Auth.adminListUsers === "function") ? Auth.adminListUsers() : [];
        if (Array.isArray(users)) {
          for (var i = 0; i < users.length; i++) {
            var uid = users[i] && users[i].id;
            if (!uid) continue;
            var rawU = localStorage.getItem(_k(KEY_DB, uid));
            var parsedU = safeJsonParse(rawU, null);
            if (parsedU && typeof parsedU === "object") {
              // premises
              if (parsedU.premises && typeof parsedU.premises === "object") {
                for (var pr in parsedU.premises) merged.premises[pr] = parsedU.premises[pr];
              }
              // links
              if (Array.isArray(parsedU.links)) {
                for (var j = 0; j < parsedU.links.length; j++) {
                  var L = parsedU.links[j];
                  if (L && typeof L === "object") {
                    var L2 = Object.assign({}, L);
                    L2._ownerId = uid;
                    merged.links.push(L2);
                  }
                }
              }
              // abonents
              if (parsedU.abonents && typeof parsedU.abonents === "object") {
                for (var a in parsedU.abonents) {
                  var A = parsedU.abonents[a];
                  if (!A) continue;
                  var A2 = Object.assign({}, A);
                  A2._ownerId = uid;
                  merged.abonents[a] = A2;
                }
              }
            }
          }
        }
      } catch (e) {}
      window.JKH_DB_READONLY = true;
      return merged;
    }

    window.JKH_DB_READONLY = false;
    const raw = localStorage.getItem(_k(KEY_DB));
    const parsed = safeJsonParse(raw, null);
    return parsed && typeof parsed === "object" ? parsed : null;
  }

  function saveToStorage(db) {
    if (!_canWriteStorage()) return false;
    localStorage.setItem(_k(KEY_DB), JSON.stringify(db));
    return true;
  }

  function normalizeDb(db) {
    if (!db) return;

    if (!db.premises || typeof db.premises !== "object") db.premises = {};
    if (!Array.isArray(db.links)) db.links = [];
    if (!db.abonents || typeof db.abonents !== "object") db.abonents = {};

    const hasLink = (abonentId, regnum) =>
      db.links.some(
        (l) =>
          String(l?.abonentId) === String(abonentId) &&
          String(l?.regnum) === String(regnum)
      );

    Object.keys(db.abonents).forEach((abonentId) => {
      const a = db.abonents[abonentId];
      if (!a) return;

      const regnum = String(a.regnum || a.premiseRegnum || "").trim();
      if (!regnum) return;

      // premises из абонента
      if (!db.premises[regnum]) {
        db.premises[regnum] = {
          regnum,
          city: a.city || "",
          street: a.street || "",
          house: a.house || "",
          flat: a.flat || "",
          square: a.square ?? a.totalArea ?? "",
          createdAt: a.premiseCreatedAt || a.premiseCreated || "2000-01-01"
        };
      }

      // links
      if (!hasLink(abonentId, regnum)) {
        db.links.push({
          abonentId: String(abonentId),
          regnum,
          dateFrom: a.calcStartDate || a.startDate || "",
          dateTo: a.calcEndDate || a.endDate || ""
        });
      }

      // нормализуем
      a.premiseRegnum = regnum;
    });

    // чистим битые links
    db.links = db.links.filter((l) => {
      const abonentOk = !!db.abonents?.[String(l?.abonentId)];
      const premiseOk = !!db.premises?.[String(l?.regnum || "").trim()];
      return abonentOk && premiseOk;
    });
  }

  // ============================================================
  // INIT global DB
  // ============================================================
  const stored = loadFromStorage();
  window.AbonentsDB = stored ? mergePreferStored(BASE_DB, stored) : deepClone(BASE_DB);
  normalizeDb(window.AbonentsDB);

  window.saveAbonentsDB = function () {
    if (!window.AbonentsDB) return;
    normalizeDb(window.AbonentsDB);
    return saveToStorage(window.AbonentsDB);
  };

  window.canWriteOrExplain = canWriteOrExplain;
  window.canWriteToStorage = _canWriteStorage;

  // Если storage пустой — сохраним пустую структуру один раз
  if (!stored) {
    window.saveAbonentsDB();
  }

  // ============================================================
  // DEMO SEED: 1006 / 1008 (новая конфигурация)
  // ============================================================
  function buildDemoDb_1006_1008() {
    // Важно: regnum должен существовать, иначе normalizeDb не создаст premises/links
    const a1006_regnum = "TEMP-20260125-0187";
    const a1008_regnum = "TEMP-20260125-8014";

    const db = deepClone(BASE_DB);

    db.abonents = {
      "1006": {
        id: "1006",
        fio: "КУДИНОВА СВЕТЛАНА ВЛАДИМИРОВНА",
        fam: "КУДИНОВА",
        name: "СВЕТЛАНА",
        otch: "ВЛАДИМИРОВНА",

        regnum: a1006_regnum,
        city: "М",
        street: "М",
        house: "1",
        flat: "1",

        square: 10,
        rooms: "",
        share: "",

        // расчёт/ответственность
        calcStartDate: "2025-01-01",
        calcEndDate: "",

        // служебное (не обязательно, но удобно)
        premiseCreatedAt: "2000-01-01"
      },

      "1008": {
        id: "1008",
        fio: "ДУПЛЕТОВА ВАЛЕРИЯ АЛЕКСАНДРОВНА",
        fam: "ДУПЛЕТОВА",
        name: "ВАЛЕРИЯ",
        otch: "АЛЕКСАНДРОВНА",

        regnum: a1008_regnum,
        city: "М",
        street: "М",
        house: "1",
        flat: "2",

        square: 10,
        rooms: "",
        share: "",

        calcStartDate: "2025-01-01",
        calcEndDate: "",
        premiseCreatedAt: "2000-01-01"
      }
    };

    normalizeDb(db);
    return db;
  }

  function seedDemoKeys_1006_1008() {
    // 1) DB
    const demoDb = buildDemoDb_1006_1008();
    saveToStorage(demoDb);

    // 2) last abonent
    localStorage.setItem(_k("last_abonent_id"), "1008");

    // 3) источники платежей
    localStorage.setItem(_k("payment_sources_v1"), JSON.stringify(["Платёж 1", "Платёж 2", "Платёж 3"]));

    // 4) тарифы (как у тебя на скрине: content/repair)
    localStorage.setItem(_k("tariffs_content_repair_v1"), JSON.stringify({
      content: [{ date: "2025-01-01", rate: 10 }],
      repair: [{ date: "2025-01-01", rate: 10 }]
    }));

    // 5) ставки рефинансирования (normal + moratorium)
    localStorage.setItem(_k("refinancing_rates_normal_v1"), JSON.stringify([
      { from: "01.01.2025", rate: "11" }
    ]));
    localStorage.setItem(_k("refinancing_rates_moratorium_v1"), JSON.stringify([
      { from: "01.04.2025", rate: "5" }
    ]));

    // 6) периоды расчёта (пустые, как на скрине)
    ["1006", "1008"].forEach((id) => {
      localStorage.setItem(_k("calc_period_" + id), JSON.stringify({ from: "", to: "" }));
      localStorage.setItem(_k("calc_period_active_" + id), "0");
      localStorage.setItem(_k("report_period_" + id), JSON.stringify({ from: "", to: "" }));
    });

    // 7) платежи — намеренно как “проверочный кейс”
    //    (формат совместим с index.html, который суммирует accrued/paid и читает paid_date)
    localStorage.setItem(_k("payments_1006"), JSON.stringify([
      // Начисления (мы специально делаем помесячные строки начислений)
      { id: 1, year: "2025", month: "01", accrued: 200, paid: 0, paid_date: "", source: "Платёж 1", payment_period: "" },
      { id: 2, year: "2025", month: "02", accrued: 200, paid: 0, paid_date: "", source: "Платёж 1", payment_period: "" },

      // Платёж (пример крупного платежа в феврале)
      { id: 3, year: "2025", month: "02", accrued: 0, paid: 3870, paid_date: "10.02.2025", source: "Платёж 1", payment_period: "" }
    ]));

    localStorage.setItem(_k("payments_1008"), JSON.stringify([
      { id: 1, year: "2025", month: "01", accrued: 200, paid: 0, paid_date: "", source: "Платёж 1", payment_period: "" }
    ]));
  }

  // ============================================================
  // BUTTON ACTIONS
  // ============================================================

  // "Сброс базы" — очистка проектных ключей
  window.testResetDatabase = function () {
    if (!canWriteOrExplain()) return;
    const ok = confirm(
      "Тестовый сброс: удалить ВСЕ данные проекта в браузере и начать с нуля?\n\n" +
      "Это действие необратимо."
    );
    if (!ok) return;

    removeProjectKeys();

    // После удаления — восстановим пустую структуру DB
    window.AbonentsDB = deepClone(BASE_DB);
    normalizeDb(window.AbonentsDB);
    saveToStorage(window.AbonentsDB);

    alert("Готово. База очищена.");
    location.reload();
  };

  // "Загрузить демо" — полностью заново: очистка + seed 1006/1008 + конфиги
  window.testLoadDemoDatabase = function () {
    if (!canWriteOrExplain()) return;
    const ok = confirm(
      "Загрузить ДЕМО (регрессионный стенд)?\n\n" +
      "Будут загружены ТОЛЬКО абоненты 1006 и 1008.\n" +
      "Текущая база и расчётные ключи будут полностью очищены."
    );
    if (!ok) return;

    removeProjectKeys();
    seedDemoKeys_1006_1008();

    // Подтянем DB в память (чтобы текущая вкладка видела сразу)
    const fresh = loadFromStorage();
    window.AbonentsDB = fresh ? mergePreferStored(BASE_DB, fresh) : deepClone(BASE_DB);
    normalizeDb(window.AbonentsDB);

    alert("Демо загружено: абоненты 1006 и 1008.");
    location.reload();
  };

  // ============================================================
  // DEV CHECK (не мешает работе)
  // ============================================================
  // Если хочешь быстро проверить, что кнопка “демо” видна:
  // console.log("data.js loaded: ", typeof window.testLoadDemoDatabase);

})();
