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
