# CODEX TASK — Premise Split v1.9.1 / безопасное разъединение квартир

## Цель

Реализовать первую безопасную версию функции разъединения квартир (`split`) в проекте ПАПАЖКХ.

Split v1 — это структурная операция. Она НЕ распределяет долги, оплаты, начисления и пеню между новыми квартирами.

## Критические документы

Использовать как обязательный канон:

- `LOGIC_SPEC.md`, раздел `16. Premise Split v1.9.1 — безопасное разъединение квартир`;
- `CHANGELOG.md`, запись `2026-05-04 — Premise Split v1.9.1`.

## Обязательные ограничения

Нельзя:

- менять `calc_engine.js`;
- переносить старый `payments_<uid>` ledger новым абонентам;
- возвращать fallback на `payments_<ЛС>`;
- автоматически делить долг;
- автоматически делить оплаты;
- удалять исходную объединённую квартиру;
- удалять старого абонента;
- выполнять split без записи в `premiseEvents`;
- оставлять локальный split после ошибки сохранения на сервер.

## Файлы для работы

Основные:

- `web/data.js`
- `web/abonent_card.html`
- `web/premises_admin.js`
- `web/index.html`

Документы уже обновлены:

- `LOGIC_SPEC.md`
- `CHANGELOG.md`

## Требуемая логика в data.js

Добавить сервисную функцию:

```js
Data.splitPremise = async function(options) { ... }
```

Минимальный вход:

```js
{
  fromRegnum: "...",
  date: "YYYY-MM-DD",
  newPremises: [
    {
      regnum: "",                 // если пусто — сгенерировать TEMP-YYYYMMDD-XXXX
      officialRegnum: "",
      city: "",
      street: "",
      house: "",
      flat: "",
      square: "",
      responsibleAbonentId: "",   // если выбран существующий
      createNewAbonent: true,
      abonent: {
        fio: "",
        phone: "",
        share: "",
        rooms: ""
      }
    }
  ],
  reason: "",
  documentNumber: "",
  documentDate: ""
}
```

## Алгоритм

1. Проверить право записи через существующий механизм `ensureWriteOrExplain()`.
2. Проверить DB readiness.
3. Создать snapshot DB до изменений.
4. Проверить `fromRegnum`.
5. Проверить дату split.
6. Проверить, что исходная квартира существует.
7. Проверить, что новых квартир минимум 2.
8. Закрыть исходную квартиру:
   - `status = "split"`;
   - `closedAt = splitDate - 1 день`;
   - `closedReason = "Разъединение квартир"`;
   - `splitAt = splitDate`;
   - `splitIntoRegnums = [...]`.
9. Закрыть активный link исходной квартиры датой `splitDate - 1 день`.
10. Старому ответственному абоненту поставить `calcEndDate = splitDate - 1 день`.
11. Для каждой новой квартиры:
   - создать active premise;
   - если regnum пустой — сгенерировать `TEMP-YYYYMMDD-XXXX`;
   - проверить уникальность `regnum`;
   - проверить уникальность `officialRegnum`, если он заполнен;
   - создать нового абонента или назначить существующего;
   - новому абоненту обязательно сгенерировать новый UID;
   - поставить `calcStartDate = splitDate`, `calcEndDate = ""`;
   - создать active link.
12. Создать событие в `premiseEvents`:
   - `type = "split"`;
   - `fromRegnums = [fromRegnum]`;
   - `toRegnums = [...]`;
   - `moneyMode = "NO_AUTO_TRANSFER"`.
13. Сохранить `abonents_db_v1` локально и на сервер.
14. Если server upload не прошёл — откатить DB к snapshot.

## UI в abonent_card.html

Добавить кнопку:

```text
Разъединить квартиру
```

Кнопка должна быть доступна только для объединённой/подходящей квартиры и только при праве записи.

Добавить модальное окно split:

- дата разъединения;
- список новых квартир;
- поля адреса/площади/официального номера;
- ответственный по каждой новой квартире;
- документ-основание;
- причина;
- предупреждение о том, что долги и оплаты не переносятся.

Перед применением обязательно подтверждение:

```text
Внимание: долги, оплаты, начисления и пеня исходной квартиры не будут распределены автоматически. Новые квартиры начнут расчёт с даты разъединения. Продолжить?
```

## UI в index.html

Добавить отображение статуса `split` так же явно, как сейчас отображаются `merged/closed`:

```text
разъединена / расчёт остановлен
```

Строки split должны быть историческими, визуально отделёнными от активных.

## Логи

Добавить минимальные логи:

```js
console.log('[premise-transform][split] start', {...});
console.log('[premise-transform][split] generated regnum', newRegnum);
console.log('[premise-transform][split] event saved', event);
console.log('[premise-transform][split] server flush ok', { ownerId });
console.warn('[premise-transform][split] blocked', { reason, regnum });
console.error('[premise-transform][split] rollback after error', e);
```

## Проверки

После реализации выполнить:

```bash
node --check web/data.js
node --check web/premises_admin.js
node --check web/storage.js
rg -n "splitPremise|premise-transform\]\[split|type: ['\"]split" web LOGIC_SPEC.md CHANGELOG.md
```

UI-проверки:

1. Создать объединённую квартиру через merge.
2. Открыть карточку объединённой квартиры.
3. Выполнить split на две новые квартиры.
4. Проверить, что исходная квартира стала `split`.
5. Проверить, что новые квартиры active.
6. Проверить, что новые абоненты получили новые UID.
7. Проверить, что старые оплаты не появились у новых абонентов.
8. Проверить, что событие `type = "split"` появилось в `premiseEvents`.
9. Сделать Ctrl+F5 и проверить главную/карточки без зависания.

## Итог от Codex

Codex должен вернуть:

1. список изменённых файлов;
2. краткий summary;
3. команды проверки;
4. важные места diff;
5. подтверждение, что `calc_engine.js` не изменялся;
6. подтверждение, что долги/оплаты не переносились автоматически.
