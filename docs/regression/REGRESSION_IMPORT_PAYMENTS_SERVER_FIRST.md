# REGRESSION_IMPORT_PAYMENTS_SERVER_FIRST

Дата: 2026-04-26  
Назначение: минимальный регресс после изменения server-first импорта оплат.

## 1. Проверка сервера

```bash
cd /root/jkh
docker compose ps
curl -i http://127.0.0.1/api/auth/me
```

`/api/auth/me` без браузерной сессии может вернуть `401 not_authenticated` — это нормально.

## 2. Проверка frontend boot

```bash
curl -s http://127.0.0.1/boot.js | head
curl -s http://127.0.0.1/autoaccrual_engine.js | head
```

Ожидаемо:
- оба файла отдаются;
- нет 404;
- нет кракозябр.

В браузере:

```js
window.JKHBoot
window.JKH_READY
window.JKHAutoAccrual
typeof window.JKHAutoAccrual.recalcForMany === 'function'
```

## 3. Backend-тесты

Если доступен pytest:

```bash
docker compose exec api python -m pytest backend/tests/test_import_payments.py -q
```

Fallback:

```bash
docker compose exec api python -m unittest backend/tests/test_import_payments.py
```

## 4. Импорт тестового файла

Тестовый сценарий:

1. Открыть `import_xls.html`.
2. Загрузить Excel с ЛС `1006` и UID `uid_moefhmpj_chndmn`.
3. Нажать `Проверить файл`.
4. Перейти в режим `Шаг 2 — Платежи`.
5. Убедиться, что кнопка показывает `Применить: добавить 4 платежей`.
6. Нажать применить.

Ожидание:

```text
Добавлено платежей: 4
```

Не должно быть:

```text
UID_LS_MISMATCH
Добавлено платежей: 0 как зелёный успех
предпросмотр очищен при полном отказе строк
```

## 5. Проверка карточки абонента

1. Открыть карточку абонента `1006`.
2. Проверить наличие платежей за:
   - `2025-01`;
   - `2025-02`;
   - `2025-03`;
   - `2025-04`.
3. Обновить страницу.
4. Убедиться, что платежи остались.
5. Проверить с другого браузера/устройства, что данные подтягиваются с сервера.

## 6. Проверка MySQL

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

Норма:

```text
последние строки import_rows имеют status=applied
rows_applied > 0
```

## 7. Проверка полного отказа

Создать/использовать строку с заведомо неверным UID или ЛС.

Ожидание:

1. Backend возвращает отказ.
2. UI показывает `err`.
3. Предпросмотр не очищается.
4. В `errorsBox` показаны `reason_code: reason_text`.

## 8. Запрещённые признаки регресса

- `window.JKHAutoAccrual undefined`.
- `boot.js 404`.
- `autoaccrual_engine.js 404`.
- `applied_count=0` показан зелёным успехом.
- `UID_LS_MISMATCH` для UID, который найден в `$.abonents."1006".uid`.
- Платёж виден до перезагрузки, но пропадает после неё.
