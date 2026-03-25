# Структура репозитория (канон)

## web/
Офлайн-фронтенд (работает через file://). Макеты, UI, расчёты в JS, LocalStorage, импорт/экспорт, печать.

## backend/
Flask API + хранилище (SQLite сейчас / MySQL позже). Источник истины для данных и прав доступа (ACL).

- backend/app.py — входная точка Flask (бывший server.py в корне)
- backend/app_src/ — исходники/черновики сервера (бывшая папка app/)
- backend/requirements.txt — зависимости бэкенда
- backend/config/ — конфиги сервера
- backend/logs/ — логи сервера (локально)

## desktop/
Упаковка/запуск как «приложение» (EXE/launcher). На этапе активной разработки можно держать замороженным.

- desktop/launcher.py — запуск сервера + открытие браузера
- desktop/build/JKH.spec — PyInstaller-спек
- desktop/build_win.bat — сборка под Windows

## docs/
ТЗ, канон, чеклисты, регрессия.

