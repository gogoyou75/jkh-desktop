# JKH Desktop (offline)

Документация v1.6.0

## 🔴 Обновление архитектуры (2026-03-25)

- введена owner-изоляция
- тарифы перенесены на уровень пользователя
- ставки рефинансирования сделаны общими для всей системы (owner=GLOBAL)
- ставки редактируются только администратором
- backend стал источником истины
- синхронизация между устройствами обязательна


## RefRates GLOBAL update — 2026-04-26

Канон уточнён:
- ставки рефинансирования не owner-level, а GLOBAL;
- ключи: `refinancing_rates_normal_v1`, `refinancing_rates_moratorium_v1`;
- backend owner: `GLOBAL`;
- write: только admin;
- read: все роли;
- запрещены `ref_rates_{owner}`, fallback-ставки и демо-инициализация.


## Storage Sync + Autoaccrual v1.8.3

Система использует строгий whitelist upload-ключей.

Нормальное поведение:
- `[JKH sync][skip-upload-not-allowed]` — ключ найден, но специально не отправлен;
- `[index][autoaccrual] skip existing payments_...` — начисления уже есть;
- `[spravka_sud][autoaccrual] skipped existing ledger` — справка читает готовый ledger.

Ошибки, которые не должны появляться:
- `POST /api/store 403` при обычной работе пользователя;
- `SyntaxError` в консоли;
- пустая справка при наличии `payments_<ЛС>`.

Ключевой принцип: UI строится из локального owner-cache, а sync не должен блокировать отображение данных.
