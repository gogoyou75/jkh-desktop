# CRITICAL_CHANGELOG

## 2026-04-26 — Server-first import payments + frontend boot-layer

### Статус
Критический архитектурный пакет. После успешной проверки должен быть слит в `main` и зафиксирован как эталон.

### Сделано

1. Добавлен единый frontend boot-layer `web/boot.js`:
   - `window.JKH_READY`;
   - `window.JKHBoot.markReady(name)`;
   - `window.JKHBoot.isReady(name)`;
   - `window.JKHBoot.waitFor(names, timeoutMs)`;
   - `window.JKHBoot.getMissing(names)`.
2. Устранена гонка загрузки на `premises.html`.
3. Разделены auth-флаги.
4. Исправлена проблема `window.JKHAutoAccrual === undefined`.
5. Добавлена серверная модель импорта платежей через batch-flow.
6. Добавлена миграция.
7. Исправлен backend UID↔ЛС lookup.
8. Добавлена классификация платежей.
9. Добавлен fingerprint платежа.
10. Обновлена apply-логика.
11. Обновлён `web/import_xls.html`.
12. Убраны alert/confirm из критичных UI.

---

## 2026-04-26 — Tariffs switched to JKHPersist (partial persist migration)

### Статус
Стабильная промежуточная точка. Проверено вручную. Готово к использованию в production.

### Сделано

1. Тарифы переведены на точечное сохранение через `JKHPersist`:
   - ключ: `tariffs_{owner}`;
   - сохранение через `/api/store`;
   - добавлена проверка `verify`.

2. В `web/tariffs.html`:
   - подключён `persist.js`;
   - добавлена функция `saveTariffsToCanonPersist()`.

3. Убрана зависимость тарифов от `uploadNow()`:
   - тарифы больше не сохраняются массовым dump;
   - `uploadNow()` используется только для `abonents_db_v1`.

4. Новый pipeline:
   saveAllFromUI()
   → recalcAll()
   → persistAccrualsAfterRecalc()

5. Разделение:
   - tariffs → JKHPersist
   - accruals → abonents_db_v1 + uploadNow

6. Расчётная логика:
   - calc_engine.js — без изменений
   - autoaccrual_engine.js — без изменений

### Проверено

- [tariffs][persist] ok
- [persist][api-store] status=ok
- перерасчёт работает
- синхронизация между устройствами есть

### Ограничения

- uploadNow пока остаётся для abonents_db_v1
- полный отказ — отдельный этап

### 2026-04-30 — STORAGE HARDENING

- введён whitelist upload-ключей
- устранены 403 ошибки /api/store
- spravka_sud больше не зависит от flush
- autoaccrual стабилизирован

Риск до изменения:
- падение UI при ошибках sync
- запись запрещённых ключей

Результат:
- стабильная работа UI независимо от сервера