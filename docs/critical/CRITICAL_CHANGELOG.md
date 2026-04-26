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
2. Устранена гонка загрузки на `premises.html`:
   - страница больше не запускает `PremisesAdmin.init()` просто по `DOMContentLoaded`;
   - запуск происходит только после готовности обязательных модулей.
3. Разделены auth-флаги:
   - `authModuleLoaded` — файл `auth.js` загружен и `window.Auth` опубликован;
   - `authSessionReady` — серверная сессия проверена;
   - legacy-флаг `auth` отмечается только после проверки сессии.
4. Исправлена проблема `window.JKHAutoAccrual === undefined` на странице квартир:
   - `autoaccrual_engine.js` обязан создать `window.JKHAutoAccrual`;
   - операции, которые требуют перерасчёта связанных абонентов, ждут готовность `autoaccrual`.
5. Добавлена серверная модель импорта платежей через batch-flow:
   - `import_batches`;
   - `import_rows`;
   - `payment_audit_log`;
   - `import_applied_fingerprints`.
6. Добавлена миграция:
   - `backend/migrations/003_batch_fingerprint_audit_core.sql`.
7. Исправлен backend UID↔ЛС lookup:
   - канонический ЛС берётся из ключа `abonents[LS]`;
   - внутреннее поле `abonent.id` используется только как fallback;
   - ложный `UID_LS_MISMATCH` для кейса UID под ключом `1006` устранён.
8. Добавлена классификация платежей:
   - `NEW_PAYMENT`;
   - `DUPLICATE`;
   - `CONFLICT`;
   - `INVALID`.
9. Добавлен fingerprint платежа:
   - базовый fingerprint: `uid + paid_date + amount`;
   - без участия месяца/периода/source;
   - цель: повторный импорт той же оплаты не должен создавать дубль.
10. Обновлена apply-логика:
   - применяется только `NEW_PAYMENT`;
   - `DUPLICATE` и `CONFLICT` не применяются;
   - повторный apply уже applied batch блокируется state-machine guard;
   - действия пишутся в `payment_audit_log`.
11. Обновлён `web/import_xls.html`:
   - если `applied_count = 0` при отправленных rows, предпросмотр не очищается;
   - причины отказа строк подтягиваются из backend `/api/import/<batch_id>/errors`;
   - зелёное сообщение больше не маскирует полный отказ строк.
12. Убраны `alert/confirm` из критичных UI-сценариев импорта/создания абонента, где это ломало flow; используются in-page статусы.

### Проверено вручную

1. Вход администратора работает.
2. `web/boot.js` отдаётся сервером.
3. `web/autoaccrual_engine.js` отдаётся сервером и создаёт `window.JKHAutoAccrual`.
4. Импорт тестового Excel-файла видит платежи.
5. Исправлен кейс:
   - ЛС: `1006`;
   - UID: `uid_moefhmpj_chndmn`;
   - платежи за `2025-01`, `2025-02`, `2025-03`, `2025-04`;
   - результат: платежи применяются, а не получают ложный `UID_LS_MISMATCH`.
6. В карточке абонента 1006 платежи появились и сохраняются после перезагрузки.

### Проверки, которые должны пройти перед эталоном

```bash
cd /root/jkh
curl -s http://127.0.0.1/boot.js | head
curl -s http://127.0.0.1/autoaccrual_engine.js | head
docker compose logs --tail=80 api
```

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

### Критические запреты

1. Не удалять `web/boot.js`.
2. Не запускать страницы напрямую через `DOMContentLoaded`, если они зависят от модулей и данных.
3. Не писать платежи из Excel напрямую в `payments_<LS>` на frontend.
4. Не считать `abonent.id` главным источником ЛС, если запись лежит в `abonents[LS]`.
5. Не очищать предпросмотр импорта при полном отказе строк.
6. Не менять MySQL-пароли, Docker volume или `.env` в рамках этих фронт/backend-фиксов.

---

## v1.6.0 — 2026-03-25

### Критическое обновление архитектуры и прав

1. Зафиксировано, что **тарифы принадлежат owner**, а не абоненту.
2. Зафиксировано, что **ставки рефинансирования принадлежат owner** и применяются ко всем его абонентам.
3. Зафиксировано жёсткое правило: **изменять ставки рефинансирования может только администратор**.
4. Зафиксировано жёсткое правило: **изменять тарифы может только администратор**.
5. Закреплено, что `owner` определяется **только сервером из сессии**.
6. Любые операции `load/save/delete/sync/dump` обязаны работать в owner-контексте.
7. Зафиксировано, что localStorage — это кэш/рабочая копия, а backend — источник истины.
8. Добавлено требование: user может только сообщить об ошибке ставки, но не менять её.
9. Добавлено будущее требование: ставки могут обновляться из интернета только через серверный контролируемый механизм с логированием и историей.
10. Зафиксировано как критичное требование: тарифы и ставки одного owner должны синхронизироваться между его устройствами.

## Важно

Следующие нарушения считаются критическими дефектами:
- доверие owner из frontend;
- возможность user менять ставки;
- возможность user менять тарифы;
- хранение тарифов на уровне абонента как первичной модели;
- рассинхрон тарифов/ставок между устройствами одного owner.
