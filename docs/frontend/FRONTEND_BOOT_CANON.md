# FRONTEND_BOOT_CANON

Дата: 2026-04-26  
Статус: обязательный канон для новых и изменяемых страниц ПАПАЖКХ.

## 1. Зачем нужен boot-layer

В проекте появились ошибки гонки загрузки: страница уже пыталась сохранять данные или запускать перерасчёт, а нужный JS-модуль ещё не успевал создать глобальный объект.

Пример реальной ошибки:

```text
window.JKHAutoAccrual === undefined
Ошибка сохранения: Не загружен autoaccrual_engine.js
```

Причина: страница запускалась по `DOMContentLoaded`, но это не гарантировало готовность всех модулей и server-first данных.

## 2. Главный принцип

Страница не должна сама угадывать порядок загрузки.

Все важные модули обязаны отмечать готовность через:

```js
window.JKHBoot?.markReady?.('moduleName');
```

Страница запускает свой init только после ожидания нужных флагов:

```js
await window.JKHBoot.waitFor(['authModuleLoaded', 'storage', 'data', 'layout', 'autoaccrual'], 5000);
```

## 3. Обязательный файл

`web/boot.js` — обязательный файл проекта.

Он создаёт:

```js
window.JKH_READY
window.JKHBoot
```

Минимальные методы:

```js
markReady(name)
isReady(name)
waitFor(names, timeoutMs)
getMissing(names)
```

`waitFor`:
- проверяет готовность каждые 50 мс;
- возвращает `true`, если все модули готовы;
- возвращает `false` по timeout;
- не бросает исключение наружу.

## 4. Порядок подключения в HTML

Для страниц, которые зависят от auth/storage/data/layout/движков, порядок должен быть таким:

```html
<script src="critical_guard.js" defer></script>
<script src="boot.js" defer></script>
<script src="auth.js" defer></script>
<script src="storage.js" defer></script>
<script src="data.js" defer></script>
<script src="layout.js" defer></script>
<script src="autoaccrual_engine.js" defer></script>
<script src="page_module.js" defer></script>
```

`boot.js` должен идти сразу после `critical_guard.js`.

## 5. Auth-флаги

В `auth.js` запрещено отмечать `auth` готовым сразу после загрузки файла.

Нужно различать:

```text
authModuleLoaded — window.Auth опубликован;
authSessionReady — серверная сессия проверена;
auth — legacy-флаг совместимости, отмечается после проверки сессии.
```

Правило:

```js
_markAuthModuleLoaded(); // сразу после window.Auth = {...}
_markAuthSessionReady(); // в finally после init()
```

## 6. Premises bootstrap

`premises.html` должен ждать:

```js
['authModuleLoaded', 'storage', 'data', 'layout', 'autoaccrual']
```

После готовности:

1. вызвать `renderLayout()`;
2. вызвать `PremisesAdmin.init()`.

Если не готовы модули — показать in-page ошибку в `#premFormWarn`, а не падать молча.

## 7. Autoaccrual

`autoaccrual_engine.js` обязан создать:

```js
window.JKHAutoAccrual
```

Минимальные методы:

```js
recalcForAbonent
recalcForMany
recalcAll
```

После публикации объекта:

```js
window.JKHBoot?.markReady?.('autoaccrual');
```

## 8. Сохранение квартиры

Если квартира не связана с абонентами:
- сохранение может пройти без перерасчёта.

Если квартира связана с абонентами:
- без `autoaccrual_engine.js` сохранять нельзя;
- нужно дождаться `autoaccrual` через `JKHBoot.waitFor(['autoaccrual'], 2000)`;
- если движок не готов — показать ошибку и остановить сохранение.

## 9. Запрещено

1. Запускать бизнес-init страницы просто по `DOMContentLoaded`, если есть зависимости.
2. Полагаться на случайный порядок `defer` как на гарантию полной готовности модулей.
3. Помечать auth-сессию готовой до завершения `/api/auth/me` / init.
4. Молча сохранять данные при отсутствии расчётного движка, если есть связанные абоненты.
5. Удалять `boot.js` как «лишний файл».

## 10. Проверки

В браузере:

```js
window.JKHBoot
window.JKH_READY
window.JKHAutoAccrual
typeof window.JKHAutoAccrual.recalcForMany === 'function'
```

На сервере:

```bash
curl -s http://127.0.0.1/boot.js | head
curl -s http://127.0.0.1/autoaccrual_engine.js | head
```

Ожидаемо:
- `boot.js` отдаётся как JS;
- `autoaccrual_engine.js` отдаётся как читаемый JS;
- нет 404;
- нет кракозябр;
- нет `window.JKHAutoAccrual undefined`.
