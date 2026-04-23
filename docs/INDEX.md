# 📚 INDEX — Карта документов проекта ПАПАЖКХ

Этот файл — навигационная карта актуальной документации.

---

## 1. Читать в первую очередь

- `docs/logic/LOGIC_SPEC.md` — актуальный архитектурный канон системы.
- `docs/critical/CRITICAL_CHANGELOG.md` — журнал критических архитектурных изменений.
- `docs/IMPORT_CANON_v2.0.md` — актуальный канон импорта Excel для первички и платежей.

Если старые документы конфликтуют с ними — приоритет у этих трёх файлов.

---

## 2. Импорт Excel

- `docs/IMPORT_CANON_v2.0.md` — новый обязательный канон импорта.
- `docs/IMPORT_CANON_v1.6.md` — предыдущая версия, оставлена как историческая база для сравнения.

### Важно
Начиная с `IMPORT_CANON_v2.0.md` зафиксированы новые правила:
- платежи учитываются только при наличии UID;
- apply платежей выполняется только на сервере;
- антидубль реализуется через fingerprint-lock;
- storage-ключ текущего ledger остаётся `payments_<ЛС>`.

---

## 3. Логика предметной области

- `docs/logic/LOGIC_SPEC.md` — актуальный канон.
- `docs/logic/LOGIC_SPEC_v1.5.3.md` — архивная расширенная логика старого этапа.
- `docs/logic/SHORT_SPEC_v1.5.1.md` — короткое ТЗ для внешнего разработчика / Codex.
- `docs/logic/LOGIC_CHECKLIST_v1.4.md` — чек-лист обязательных проверок после правок.
- `docs/logic/PRE_CHANGE_CHECKLIST.md` — что проверить перед изменениями.

---

## 4. Хранение и границы системы

- `docs/STORAGE_BOUNDARY.md` — граница localStorage ↔ backend / БД.
- `docs/STORAGE_CANON_RULE.md` — дополнительные правила хранения.

---

## 5. Критические документы

- `docs/critical/CRITICAL_DO_NOT_TOUCH.md`
- `docs/critical/CRITICAL_CHANGELOG.md`
- `docs/critical/CRITICAL_INDEX.md`

---

## 6. Регрессия

- `docs/regression/REGRESSION_TEST_v1.6_CANON.md`

После правок импорта, owner, тарифов, ставок, sync регрессия обязательна.

---

## 7. Как использовать это для Codex

Перед новым заданием Codex давать минимум такой пакет:
1. `docs/logic/LOGIC_SPEC.md`
2. `docs/critical/CRITICAL_CHANGELOG.md`
3. `docs/IMPORT_CANON_v2.0.md`
4. `docs/STORAGE_BOUNDARY.md`

Этого достаточно, чтобы Codex не ушёл в ложную архитектуру импорта и хранения.
