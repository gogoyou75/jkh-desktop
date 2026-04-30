# CANON_VERSION

Project: ПАПАЖКХ  
Version: v1.8.3  
Status: ETALON (обновлено под новую архитектуру)  
Date: 2026-04-30

## CANON TRANSFER v18
- Передача задолженности и пени между абонентами работает корректно
- WITH_DEBT: долг и пеня переходят, пеня продолжает расти у нового абонента
- WITHOUT_DEBT: новый абонент с нуля, старый замораживается
- freeze_to = transfer_date - 1 день

## CANON TRANSFER v19 (ARCHITECTURE UPDATE — 2026-03-25)

- Введена owner-изоляция данных (server-side only)
- owner определяется только сервером (из сессии)
- Тарифы:
  - принадлежат пользователю (owner)
  - едины для всех абонентов пользователя
- Ставки рефинансирования:
  - являются общими для всей системы (GLOBAL)
  - одинаковы для всех пользователей и всех баз
  - изменяются только администратором
- Пользователь:
  - не может изменять тарифы и ставки
  - имеет только read-only доступ
  - может отправить сообщение об ошибке ставки
- Backend:
  - источник истины
- LocalStorage:
  - используется как кэш
- Добавлено требование синхронизации между устройствами owner


## RefRates GLOBAL update — 2026-04-26

Канон уточнён:
- ставки рефинансирования не owner-level, а GLOBAL;
- ключи: `refinancing_rates_normal_v1`, `refinancing_rates_moratorium_v1`;
- backend owner: `GLOBAL`;
- write: только admin;
- read: все роли;
- запрещены `ref_rates_{owner}`, fallback-ставки и демо-инициализация.


## STORAGE SYNC + AUTOACCRUAL HARDENING v1.8.3 — 2026-04-30

Канон уточнён:
- `payments_<ЛС>` — канонический owner-scoped ledger начислений/оплат;
- `JKHAutoAccrual.recalcForAbonent()` обязан сохранять ledger в тот же owner, из которого UI его читает;
- `index.html` не делает массовый blind-recalc, а сначала проверяет ledger и ремонтирует только отсутствующие начисления;
- `spravka_sud.js` строится из локального ledger и не падает при ошибке upload;
- `storage.js` использует строгий upload whitelist `_isUploadAllowedKey()`;
- legacy/admin/global ключи читаются при необходимости, но обычным owner-upload не отправляются;
- `tariffs_<ownerId>` — единственный разрешённый upload-ключ тарифов;
- `refinancing_rates_normal_v1` и `refinancing_rates_moratorium_v1` — GLOBAL/admin-only, обычным upload не отправляются.

Запрещено:
- `await Data.flushDbToServer()` без `try/catch` в UI-сценариях;
- `changed:true` при пустом ledger;
- upload неизвестных, legacy или GLOBAL/admin-only ключей;
- считать `paid > 0` полноценным ledger без `accrued > 0`.
