# IMPORT_PAYMENTS_CANON

Этот файл — короткая точка входа. Полный канон смотри в:

```text
docs/payments/PAYMENTS_SERVER_FIRST_CANON.md
```

## Коротко

1. Excel не пишет платежи напрямую в `payments_<LS>`.
2. Frontend парсит Excel и отправляет rows на backend.
3. Backend создаёт batch.
4. Validate классифицирует строки:
   - `NEW_PAYMENT`;
   - `DUPLICATE`;
   - `CONFLICT`;
   - `INVALID`.
5. Apply применяет только `NEW_PAYMENT`.
6. Все действия пишутся в `payment_audit_log`.
7. Повторный apply уже applied batch запрещён.
8. Канонический ЛС при UID-поиске — ключ `abonents[LS]`, а не только `abonent.id`.
9. Если `applied_count=0`, UI не очищает предпросмотр и показывает причины отказа.

## Проверочный кейс

```text
ЛС: 1006
UID: uid_moefhmpj_chndmn
Ожидание: платежи проходят validate и apply, не получают ложный UID_LS_MISMATCH.
```
