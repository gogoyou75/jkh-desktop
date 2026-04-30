# UPDATED FILES

Файлы, обновлённые в патче документации от 2026-03-25:

- docs/logic/LOGIC_SPEC.md
- docs/logic/LOGIC_SPEC_v1.5.3.md
- docs/logic/SHORT_SPEC_v1.5.1.md
- docs/STORAGE_BOUNDARY.md
- docs/logic/LOGIC_CHECKLIST_v1.4.md
- docs/critical/CRITICAL_CHANGELOG.md
- docs/INDEX.md

Смысл патча:
- owner только с сервера;
- тарифы = owner-level;
- ставки = GLOBAL;
- менять ставки и тарифы может только admin;
- user только read-only + сообщение об ошибке ставки;
- sync между устройствами owner обязателен;
- автообновление ставок в будущем только через server-side контролируемый механизм.


## RefRates GLOBAL update — 2026-04-26

Канон уточнён:
- ставки рефинансирования не owner-level, а GLOBAL;
- ключи: `refinancing_rates_normal_v1`, `refinancing_rates_moratorium_v1`;
- backend owner: `GLOBAL`;
- write: только admin;
- read: все роли;
- запрещены `ref_rates_{owner}`, fallback-ставки и демо-инициализация.

## 2026-04-30

Обновлены:

- web/storage.js (whitelist upload)
- web/spravka_sud.js (resilient flush)
- web/index.html (rebuild после autoaccrual)
- web/autoaccrual_engine.js (фикс сохранения ledger)

Смысл:
- устранена зависимость UI от сервера
- устранены 403 ошибки
- введена защита от некорректных ключей