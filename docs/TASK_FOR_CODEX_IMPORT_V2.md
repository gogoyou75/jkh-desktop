# TASK_FOR_CODEX_IMPORT_V2.md

## ЗАДАЧА

Довести backend импорта платежей до нового канона IMPORT_CANON_v2.0.

Цель:
сделать 100% идемпотентный, server-first импорт платежей
без дублей, без потери данных и без нарушения текущего storage-пласта.

---

## КРИТИЧЕСКИЙ КАНОН (ОБЯЗАТЕЛЬНО)

### 1. Платежи учитываются ТОЛЬКО при наличии UID

- account_uid обязателен
- если UID отсутствует → строка не проводится
- никаких fallback:
  - ❌ нельзя искать только по ЛС
  - ❌ нельзя подменять UID через ЛС

---

### 2. Storage-ключ остаётся ТОЛЬКО по ЛС

Правильный ключ:

payments_<account_number>

Запрещено:

payments_<uid>   ❌

Если запись идёт не в payments_<ЛС> — это критическая ошибка архитектуры.

---

### 3. Антидубль через fingerprint (server-side)

Обязательно:

- fingerprint считается на сервере
- используется таблица:
  - import_applied_fingerprints
- уникальность:
  UNIQUE (owner_id, import_type, fingerprint)

---

### 4. Fingerprint строится только из нормализованных значений

Состав:

owner_id
account_uid
account_number
paid_date (YYYY-MM-DD)
amount (Decimal 2)
source_index (int)
payment_period (YYYY-MM)

---

### 5. Форматы данных

#### В fingerprint / SQL:

- дата: YYYY-MM-DD
- период: YYYY-MM
- сумма: Decimal(2)

#### В текущем ledger (KV/JSON):

- paid_date: DD.MM.YYYY  ← ОБЯЗАТЕЛЬНО (legacy совместимость)

---

### 6. Server-first apply

- apply выполняется только на сервере
- браузер ничего не записывает напрямую

---

### 7. Транзакционная модель

Для каждой строки:

begin_nested()
  insert fingerprint
  write payment в ledger
commit

Если ошибка:
- строка = failed
- fingerprint не должен остаться без платежа

---

## ЧТО НУЖНО ИСПРАВИТЬ В ТЕКУЩЕМ КОДЕ

### ❗ 1. Исправить storage key

Было (неправильно):

key = f"payments_{normalized_uid}"

Должно быть:

key = f"payments_{normalized_account_number}"

---

### ❗ 2. Убрать fallback account_number → UID

Было:

account_number or account_uid

Нужно:

normalize_account_number(r.account_number)

Если нет ЛС:
- строка = failed
- reason_code = ACCOUNT_NUMBER_REQUIRED

---

### ❗ 3. UID обязателен

В validate:

if not account_uid:
    status = invalid
    reason_code = ACCOUNT_UID_REQUIRED

---

### ❗ 4. Исправить формат paid_date в ledger

Сейчас (неправильно):

"paid_date": normalized_paid_date  # YYYY-MM-DD

Должно быть:

paid_date_display = datetime.strptime(normalized_paid_date, "%Y-%m-%d").strftime("%d.%m.%Y")

"paid_date": paid_date_display

---

### ❗ 5. Не проводить строки без UID или ЛС

В apply:

Если:
- нет UID
- нет ЛС

→ строка:

status = failed
reason_code = ACCOUNT_DATA_INVALID

---

## СТАТУСЫ СТРОК

Использовать только:

- ready
- applied
- duplicate
- failed

---

### duplicate

reason_code = DUPLICATE_FINGERPRINT

---

### failed

reason_code = APPLY_ERROR / ACCOUNT_UID_REQUIRED / ACCOUNT_NUMBER_REQUIRED

---

## ТЕСТЫ (ОБЯЗАТЕЛЬНЫ)

### 1. Повторный импорт

- applied_count = 0
- duplicate_count > 0

---

### 2. Частичное пересечение

- старые → duplicate
- новые → applied

---

### 3. Нет UID

- строка не проводится
- status = invalid/failed

---

### 4. Нет ЛС

- строка не проводится
- status = failed

---

### 5. Проверка storage

После apply:

- данные должны быть в:
  payments_<ЛС>

- не должно быть:
  payments_<UID>

---

## ЗАПРЕЩЕНО

- ❌ менять storage-пласт полностью
- ❌ писать платежи по UID
- ❌ проводить платежи без UID
- ❌ менять формат ledger (DD.MM.YYYY)
- ❌ делать дедупликацию в браузере

---

## РЕЗУЛЬТАТ

После выполнения:

- импорт идемпотентен
- дубли невозможны
- storage остаётся совместимым
- UI не ломается
- backend становится источником истины

---

## ЧТО ВЕРНУТЬ

1. diff файлов
2. подтверждение:
   - используется payments_<ЛС>
   - UID обязателен
   - paid_date в ledger = DD.MM.YYYY
3. результат тестов
4. список рисков (если остались)
