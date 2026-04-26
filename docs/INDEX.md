# ПАПАЖКХ — индекс документации

Дата обновления: 2026-04-26

## Критические документы

- `docs/critical/CRITICAL_CHANGELOG.md` — критические изменения архитектуры.
- `docs/critical/CRITICAL_DO_NOT_TOUCH.md` — что нельзя ломать.
- `docs/critical/CRITICAL_INDEX.md` — индекс критичных правил.

## Логика проекта

- `docs/logic/LOGIC_SPEC.md` — актуальная логическая спецификация.
- `docs/logic/LOGIC_SPEC_v1.5.3.md` — зафиксированная версия логики.
- `docs/logic/LOGIC_CHECKLIST_v1.4.md` — чеклист логики.
- `docs/logic/PRE_CHANGE_CHECKLIST.md` — проверка перед изменениями.

## Server-first и storage

- `docs/STORAGE_BOUNDARY.md` — границы storage.
- `docs/STORAGE_CANON_RULE.md` — правила storage.
- `docs/STRUCTURE.md` — структура проекта.

## Frontend boot-layer

- `docs/frontend/FRONTEND_BOOT_CANON.md` — канон инициализации frontend без гонок.

Ключевые правила:

- `web/boot.js` обязателен.
- `authModuleLoaded` отделён от `authSessionReady`.
- Страница не запускает init до готовности зависимостей.
- `autoaccrual_engine.js` должен создать `window.JKHAutoAccrual` до перерасчётов.

## Импорт оплат

- `docs/IMPORT_PAYMENTS_CANON.md` — короткий канон импорта оплат.
- `docs/payments/PAYMENTS_SERVER_FIRST_CANON.md` — полный server-first канон оплат.
- `docs/regression/REGRESSION_IMPORT_PAYMENTS_SERVER_FIRST.md` — регресс-тест server-first импорта оплат.

Ключевые правила:

- Excel/frontend не применяет платежи напрямую.
- Backend применяет платежи через batch-flow.
- Канонический ЛС при UID-поиске — ключ `abonents[LS]`.
- `applied_count=0` не должен маскироваться зелёным успехом.

## Импорт данных

- `docs/IMPORT_CANON_v1.6.md` — общий канон импорта.
- `docs/regression/REGRESSION_TEST_v1.6_CANON.md` — общий регресс по импорту.

## Codex-задачи

- `docs/TASK_FOR_CODEX.md`
- `docs/TASK_FOR_CODEX_PHASE2.md`
- `docs/TASK_FOR_CODEX_PHASE3.md`
- `docs/codex/TASK_FOR_CODEX_DOCS_BOOT_PAYMENTS.md`
- `docs/codex/TASK_FOR_CODEX_PAYMENTS_SERVER_FIRST.md`
- `docs/codex/TASK_FOR_CODEX_BOOT_AND_PAYMENTS_REGRESSION.md`

## Desktop / EXE

- `docs/desktop/README_DESKTOP.md`
- `docs/EXE_FREEZE.md`

## Архив

- `docs/archive/ARCHIVE_ETALON.md`

## Текущее обязательное правило после 2026-04-26

Если меняются импорт оплат, boot-layer, auth-init, storage-init или autoaccrual:

1. обновить соответствующий канон;
2. обновить регресс;
3. не мержить в `main` без ручной проверки импорта платежей;
4. не делать эталон без проверки карточки абонента после перезагрузки.
