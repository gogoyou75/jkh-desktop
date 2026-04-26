# PAYMENTS_SERVER_FIRST_CANON

Дата: 2026-04-26  
Статус: обязательный канон импорта и учёта оплат.

## 1. Главный принцип

Сервер — источник истины.

Excel/frontend не должен напрямую и окончательно писать платежи в `payments_<LS>` без серверной проверки.

Правильная цепочка:

```text
Excel → frontend parse/preview → backend batch upload → validate → apply → server storage/audit → UI reload
```

## 2. Что делает frontend

Frontend имеет право:

1. прочитать Excel;
2. показать предпросмотр;
3. посчитать предварительное количество платежей;
4. отправить нормализованные rows на backend;
5. показать результат backend;
6. не очищать предпросмотр, если backend отклонил все строки.

Frontend не является источником истины для применения платежей.

## 3. Что делает backend

Backend обязан:

1. создать batch;
2. сохранить строки в `import_rows`;
3. выполнить validate;
4. классифицировать каждую строку;
5. применить только допустимые строки;
6. записать audit;
7. защитить повторный apply.

## 4. Таблицы

Канонические таблицы server-first импорта оплат:

```text
import_batches
import_rows
payment_audit_log
import_applied_fingerprints
```

Миграция:

```text
backend/migrations/003_batch_fingerprint_audit_core.sql
```

## 5. Batch state-machine

Batch проходит состояния:

```text
uploaded → validated → applied
```

Повторное применение `applied` batch запрещено.

Если apply падает — сервер должен откатить транзакцию.

## 6. Классификация строки платежа

Строка классифицируется в validate-flow.

Возможные классы:

```text
NEW_PAYMENT — новый платёж, можно применить;
DUPLICATE — такой платёж уже есть, не применять;
CONFLICT — похожий платёж конфликтует, не применять без решения;
INVALID — строка некорректна, не применять.
```

## 7. Fingerprint

Fingerprint платежа нужен для защиты от дублей.

Канон fingerprint:

```text
uid + paid_date + amount
```

Месяц начисления, период оплаты и source не участвуют в fingerprint.

Причина: реальный банковский платёж определяется фактом оплаты, датой и суммой, а не тем, за какой месяц пользователь потом распределяет оплату.

## 8. UID ↔ ЛС

UID — идентификатор абонента.

ЛС — счёт/ключ в базе.

Канонический ЛС при поиске UID берётся из ключа объекта:

```json
{
  "abonents": {
    "1006": {
      "uid": "uid_moefhmpj_chndmn",
      "id": "1006"
    }
  }
}
```

В этом примере канонический ЛС = `1006`, потому что запись лежит в `abonents["1006"]`.

`abonent.id` используется только как fallback.

## 9. UID_LS_MISMATCH

`UID_LS_MISMATCH` допустим только если:

1. UID найден;
2. канонический ключ ЛС не совпадает с `account_number` из import row;
3. fallback `abonent.id` тоже не совпадает.

Ложный кейс, который запрещён:

```text
account_uid = uid_moefhmpj_chndmn
account_number = 1006
JSON_SEARCH → $.abonents."1006".uid
```

Такой платёж должен проходить validate, а не получать `UID_LS_MISMATCH`.

## 10. Apply

Apply должен:

1. применять только `NEW_PAYMENT`;
2. не применять `DUPLICATE`;
3. не применять `CONFLICT`;
4. не применять `INVALID`;
5. писать результат в `payment_audit_log`;
6. добавлять fingerprint применённого платежа;
7. работать атомарно.

## 11. UI import_xls.html

Если frontend отправил rows, но backend вернул:

```text
applied_count = 0
```

то UI обязан:

1. показать статус `err`, а не зелёный успех;
2. не очищать предпросмотр;
3. запросить `/api/import/<batch_id>/errors`;
4. показать `reason_code: reason_text` пользователю.

Запрещено маскировать полный отказ строк сообщением:

```text
Импорт завершён. Добавлено платежей: 0.
```

как успешный импорт.

## 12. Проверочный кейс 1006

Тестовый кейс, которым была найдена ошибка:

```text
ЛС: 1006
UID: uid_moefhmpj_chndmn
Платежи:
2025-01 — 1264.80
2025-02 — 1264.80
2025-03 — 1264.80
2025-04 — 1264.80
```

Диагностика доказала:

```sql
JSON_SEARCH(v, 'one', 'uid_moefhmpj_chndmn', NULL, '$.abonents.*.uid')
→ $.abonents."1006".uid
```

Значит backend должен считать UID и ЛС совпавшими.

## 13. Проверки MySQL

```bash
docker compose exec mysql mysql -uroot -p'07031975TSv' -D jkh -e "
SELECT id,status,rows_total,rows_valid,rows_invalid,rows_duplicate,rows_applied
FROM import_batches
ORDER BY id DESC
LIMIT 5;

SELECT id,batch_id,status,reason_code,account_uid,account_number,payment_period,amount
FROM import_rows
ORDER BY id DESC
LIMIT 20;
"
```

Норма после успешного импорта:

```text
последние строки import_rows → applied
rows_applied > 0
```

## 14. Запрещено

1. Писать платежи напрямую из Excel в LocalStorage как финальный источник.
2. Считать успешным импорт с `applied_count=0`, если были отправленные rows.
3. Сравнивать UID/ЛС без нормализации.
4. Использовать `abonent.id` как единственный источник ЛС.
5. Применять batch повторно.
6. Применять duplicate/conflict строки.
