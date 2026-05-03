
# UPDATED FILES

## 2026-05-03 — v1.9.0 UID Payments + Premise Merge

Файлы документации, обновлённые для замены:

- `CANON_VERSION.md`
- `PROMPT_CANON.md`
- `README.md`
- `UPDATED_FILES.md`
- `docs/logic/LOGIC_SPEC.md`
- `docs/logic/LOGIC_SPEC_v1.9.0_UID_PAYMENTS_PREMISE_MERGE.md`
- `docs/STORAGE_BOUNDARY.md`
- `docs/critical/CRITICAL_CHANGELOG.md`
- `docs/logic/LOGIC_CHECKLIST_v1.4.md`
- `docs/INDEX.md`

Кодовые изменения, которые зафиксированы документально:

- `web/data.js` — UID обязателен, `getPaymentsKeyForAbonent`, миграция legacy UID.
- `web/payment_table.js` — чтение оплат только после Data Ready и только по UID-key.
- `web/autoaccrual_engine.js` — UID-only ledger read/write.
- `web/calc_engine.js` — UID-first загрузка оплат.
- `web/import_xls.html` — импорт платежей по UID.
- `web/index.html` — проверка ledger по UID.
- `web/new_abonent.html` — новый абонент всегда получает UID.
- `web/abonent_card.html` — server-first init карточки/оплат.
- `web/premises_admin.js` / `web/data.js` / `web/abonent_card.html` — объединение квартир, статусы merged/closed, новый ЛС/UID.

Смысл патча:
- устранено наследование старых оплат при повторном ЛС;
- канонический ключ оплат теперь `payments_<uid>`;
- добавлена функция объединения квартир;
- старые квартиры и абоненты закрываются исторически;
- новая объединённая квартира начинает новый расчёт с нового UID/ЛС.
