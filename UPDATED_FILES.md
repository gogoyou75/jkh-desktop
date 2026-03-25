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
- ставки = owner-level;
- менять ставки и тарифы может только admin;
- user только read-only + сообщение об ошибке ставки;
- sync между устройствами owner обязателен;
- автообновление ставок в будущем только через server-side контролируемый механизм.
