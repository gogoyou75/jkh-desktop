# PROMPT_CANON — ПАПАЖКХ

Версия: v1.8.3

## 🔴 CRITICAL ARCHITECTURE UPDATE (2026-03-25)

Перед выполнением любых задач обязательно учитывать:

1. Все данные привязаны к owner (user_id)
2. owner определяется только сервером
3. Тарифы:
   - уровень owner
   - НЕ уровень абонента
4. Ставки рефинансирования:
   - уровень GLOBAL (общие для всей системы)
   - одинаковы для всех owner
   - изменяются только администратором
5. Пользователь:
   - read-only для тарифов и ставок
6. Backend:
   - источник истины
7. LocalStorage:
   - только кэш
8. Sync:
   - обязателен между устройствами одного owner

Нарушение любого пункта = критическая ошибка

---

Остальная часть ТЗ действует без изменений.


## RefRates GLOBAL update — 2026-04-26

Канон уточнён:
- ставки рефинансирования не owner-level, а GLOBAL;
- ключи: `refinancing_rates_normal_v1`, `refinancing_rates_moratorium_v1`;
- backend owner: `GLOBAL`;
- write: только admin;
- read: все роли;
- запрещены `ref_rates_{owner}`, fallback-ставки и демо-инициализация.


## 🔴 STORAGE SYNC + AUTOACCRUAL RULE (2026-04-30)

Перед выполнением задач Codex обязательно учитывать:

1. `payments_<ЛС>` — owner-scoped ledger.
2. Autoaccrual обязан писать и проверять ledger в одном ownerId.
3. `index.html` сначала читает ledger, потом точечно ремонтирует отсутствующие начисления.
4. `spravka_sud.js` не имеет права падать из-за `Data.flushDbToServer()`.
5. Upload работает только по whitelist `_isUploadAllowedKey()`.
6. Legacy ключи тарифов read-only/migration only.
7. GLOBAL/admin-only ключи `refinancing_rates_*` не отправляются обычным owner-upload.
8. UI должен строиться даже при ошибке sync, если локальные данные есть.

Нарушение любого пункта = критическая ошибка.
