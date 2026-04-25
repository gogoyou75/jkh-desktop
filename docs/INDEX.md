# 📚 INDEX — Карта документов проекта ПАПАЖКХ

Этот файл — навигационная карта актуальной документации.

---

## 1. Читать в первую очередь

- `docs/logic/LOGIC_SPEC.md` — актуальный канон по owner, тарифам, ставкам, sync и будущему автообновлению ставок.
- `docs/critical/CRITICAL_CHANGELOG.md` — журнал критических архитектурных изменений.

Если старые документы конфликтуют с ними — приоритет у этих двух файлов.

---

## 2. Логика предметной области

- `docs/logic/LOGIC_SPEC_v1.5.3.md` — расширенная логика с patch-уточнением под owner/sync/roles.
- `docs/logic/SHORT_SPEC_v1.5.1.md` — короткое ТЗ для внешнего разработчика / Codex.
- `docs/logic/LOGIC_CHECKLIST_v1.4.md` — чек-лист обязательных проверок после правок.
- `docs/logic/PRE_CHANGE_CHECKLIST.md` — что проверить перед изменениями.

---

## 3. Хранение и границы системы

- `docs/STORAGE_BOUNDARY.md` — граница localStorage ↔ backend / БД.
- `docs/STORAGE_CANON_RULE.md` — дополнительные правила хранения.

---

## 4. Критические документы

- `docs/critical/CRITICAL_DO_NOT_TOUCH.md`
- `docs/critical/CRITICAL_CHANGELOG.md`
- `docs/critical/CRITICAL_INDEX.md`

---

## 5. Регрессия

- `docs/regression/REGRESSION_TEST_v1.6_CANON.md`

После правок owner / тарифов / ставок / sync регрессия обязательна.

---

## 6. Архив и сопутствующие

- `docs/archive/ARCHIVE_ETALON.md`
- `docs/logic/AUDIT_VERSION_NOTE.md`
- `docs/CHECKLIST.md`
- `docs/CONTEXT.md`

---

## 7. Как использовать это для Codex

Перед новым заданием Codex дать минимум такой пакет:
1. `docs/logic/LOGIC_SPEC.md`
2. `docs/critical/CRITICAL_CHANGELOG.md`
3. `docs/STORAGE_BOUNDARY.md`
4. `docs/logic/LOGIC_CHECKLIST_v1.4.md`

Этого достаточно, чтобы Codex не ушёл в ложную архитектуру.

---

## 8. Frontend boot / загрузка модулей

- `docs/frontend/FRONTEND_BOOT_CANON.md` — канон безопасной инициализации фронта без гонок загрузки.

---

## 9. Оплаты server-first

- `docs/payments/PAYMENTS_SERVER_FIRST_CANON.md` — канон добавления, редактирования, импорта и серверного сохранения оплат.

---

## 10. Задания для Codex по новой архитектуре

- `docs/codex/TASK_FOR_CODEX_PAYMENTS_SERVER_FIRST.md` — внедрение/проверка ручного добавления оплаты через сервер.
- `docs/codex/TASK_FOR_CODEX_BOOT_AND_PAYMENTS_REGRESSION.md` — регрессия boot-layer + оплаты.
