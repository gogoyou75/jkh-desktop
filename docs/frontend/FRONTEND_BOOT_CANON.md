# FRONTEND_BOOT_CANON.md

Версия: **v1.0 — 2026-04-25**  
Статус: **КАНОН ДЛЯ ВСЕХ СТРАНИЦ ФРОНТА ПАПАЖКХ**

---

## 1. Цель

Исключить гонки загрузки JavaScript-модулей, когда страница начинает работать раньше, чем готовы `auth.js`, `storage.js`, `data.js`, расчётные движки или server-first данные.

Проблема, из-за которой введён канон: на `premises.html` сохранение квартиры блокировалось сообщением о незагруженном `autoaccrual_engine.js`, хотя файл мог появляться позже.

---

## 2. Обязательный boot-layer

В проекте должен существовать файл:

```text
web/boot.js
```

Он публикует:

```js
window.JKH_READY
window.JKHBoot
```

Минимальный API:

```js
window.JKHBoot.markReady(name)
window.JKHBoot.isReady(name)
window.JKHBoot.waitFor(names, timeoutMs)
window.JKHBoot.getMissing(names)
```

`waitFor()` обязан:

- проверять готовность каждые 50 мс;
- возвращать `true`, если все модули готовы;
- возвращать `false` по таймауту;
- не бросать исключения наружу.

---

## 3. Правило подключения скриптов

Для страниц, где есть сохранение данных, порядок должен быть таким:

```html
<script src="critical_guard.js" defer></script>
<script src="boot.js" defer></script>
<script src="auth.js" defer></script>
<script src="storage.js" defer></script>
<script src="data.js" defer></script>
<script src="layout.js" defer></script>
<!-- затем движки страницы -->
<script src="autoaccrual_engine.js" defer></script>
<!-- затем контроллер страницы -->
<script src="premises_admin.js" defer></script>
```

Запрещено подключать контроллер страницы раньше его движков.

---

## 4. Флаги готовности

Каждый модуль после публикации своего глобального объекта отмечает готовность.

Обязательные флаги:

```text
authModuleLoaded     — auth.js загружен и window.Auth опубликован
authSessionReady     — Auth.init() завершил проверку серверной сессии
auth                 — legacy-флаг совместимости, ставится только после authSessionReady
storage              — window.JKHStore / window.JKHStorage готовы
data                 — window.Data готов
layout               — renderLayout готов
autoaccrual          — window.JKHAutoAccrual готов
```

Критическое правило: `auth` нельзя отмечать до завершения `Auth.init()`.

---

## 5. Запуск страницы

Страница не должна вызывать `PremisesAdmin.init()` напрямую по `DOMContentLoaded`.

Правильная модель:

```js
document.addEventListener('DOMContentLoaded', async () => {
  const required = ['authModuleLoaded', 'storage', 'data', 'layout', 'autoaccrual'];
  const ok = await window.JKHBoot.waitFor(required, 5000);

  if (!ok) {
    const missing = window.JKHBoot.getMissing(required);
    showPageError('Не готовы модули: ' + missing.join(', '));
    return;
  }

  renderLayout();
  PremisesAdmin.init();
});
```

---

## 6. Сохранение данных

Перед сохранением страница обязана проверить:

- пользователь не гость;
- не выбран режим `ALL`;
- `window.AbonentsDB` существует;
- `window.JKHStore` готов;
- `window.Data.flushDbToServer` доступен;
- если операция влияет на начисления — готов `autoaccrual_engine.js`.

---

## 7. Правило для помещений / квартир

Если квартира не связана с абонентами — сохранение адреса/площади может идти без перерасчёта.

Если квартира связана с абонентами — без `window.JKHAutoAccrual.recalcForMany()` сохранять запрещено.

Причина: изменение площади меняет начисления.

---

## 8. Ошибки

Ошибка должна называть точную причину:

- `Не готовы модули: ...`
- `Не найден renderLayout()`
- `PremisesAdmin не найден`
- `Не загружен autoaccrual_engine.js. Сохранение остановлено, чтобы не нарушить начисления.`

Запрещены общие ошибки без причины.

---

## 9. Регрессия

После изменения boot/auth/storage/data/layout/движков обязательно проверить:

```js
window.JKHBoot
window.JKH_READY
window.JKHAutoAccrual
typeof window.JKHAutoAccrual.recalcForMany === 'function'
```

На сервере:

```bash
curl -s http://127.0.0.1/boot.js | head -n 5
curl -s http://127.0.0.1/autoaccrual_engine.js | head -n 5
```

В браузере: `Ctrl + Shift + R` при включённом `Disable cache`.
