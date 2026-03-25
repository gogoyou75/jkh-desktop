# STORAGE CANON RULE (ПАПАЖКХ)

Дата: 2026-02-05

## Правило
Прямые обращения к `localStorage.*` запрещены во всех файлах проекта,
кроме `web/storage.js`.

## Единственная дверь к данным
- `window.JKHStore` (StorageAdapter)
- `window.JKHStorage` (scoped keys helper)
- `window.StorageAPI` (legacy compatibility внутри storage.js)

## Проверка
Для контроля используется режим `?dev=1`:
- если где-то вне `storage.js` появится `localStorage.*`,
  guard выдаст warning в Console.
