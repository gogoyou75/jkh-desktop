# TASK_FOR_CODEX_DOCS_BOOT_PAYMENTS

Задача: добавить и закрепить документацию после пакета изменений `frontend boot-layer + server-first import payments`.

## Важно

Это задание только на документацию. Код не менять.

## Полностью заменить / добавить файлы

1. `docs/critical/CRITICAL_CHANGELOG.md`
2. `docs/frontend/FRONTEND_BOOT_CANON.md`
3. `docs/payments/PAYMENTS_SERVER_FIRST_CANON.md`
4. `docs/IMPORT_PAYMENTS_CANON.md`
5. `docs/INDEX.md`
6. `docs/regression/REGRESSION_IMPORT_PAYMENTS_SERVER_FIRST.md`

## Что обязательно зафиксировать

### Frontend boot-layer

- `web/boot.js` теперь обязательный boot-layer.
- `window.JKH_READY` и `window.JKHBoot` являются каноном готовности модулей.
- `authModuleLoaded` отделён от `authSessionReady`.
- `premises.html` не должен запускать `PremisesAdmin.init()` до готовности зависимостей.
- `autoaccrual_engine.js` обязан создать `window.JKHAutoAccrual` до операций перерасчёта.

### Server-first import payments

- Excel/frontend не применяет платежи напрямую.
- Применение платежей идёт через backend batch-flow:
  `upload_rows → validate → apply`.
- Канонические таблицы:
  `import_batches`, `import_rows`, `payment_audit_log`, `import_applied_fingerprints`.
- Миграция:
  `backend/migrations/003_batch_fingerprint_audit_core.sql`.
- Классификация строк:
  `NEW_PAYMENT`, `DUPLICATE`, `CONFLICT`, `INVALID`.
- Apply применяет только `NEW_PAYMENT`.
- Fingerprint: `uid + paid_date + amount`.
- Канонический ЛС при UID-поиске — ключ `abonents[LS]`, а `abonent.id` только fallback.
- Ложный `UID_LS_MISMATCH` для UID под ключом `1006` запрещён.
- Если `applied_count=0`, frontend не очищает предпросмотр и показывает причины отказа.

## Тестовый кейс для фиксации

```text
ЛС: 1006
UID: uid_moefhmpj_chndmn
Периоды: 2025-01, 2025-02, 2025-03, 2025-04
Сумма: 1264.80
Ожидание: строки применяются, а не получают UID_LS_MISMATCH.
```

## Проверка после документации

- В `docs/INDEX.md` есть ссылки на новые каноны.
- В `docs/critical/CRITICAL_CHANGELOG.md` есть запись от 2026-04-26.
- Нет инструкций менять MySQL-пароли, Docker volume или `.env`.
