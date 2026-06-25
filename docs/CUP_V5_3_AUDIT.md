# CUP v5.3 LAB/PROD safety audit

Дата аудита: 2026-06-25
Ветка: `codex/stage19-final-razriv-i`
Проверенный файл: `scripts/jkh_server_menu_v5_3.sh`

## Итог

CRITICAL-риски: не найдено.

Найдены MEDIUM-риски, которые являются осознанным поведением меню:
- LAB self-heal может перезаписать `docker-compose.yml` после Git checkout/pull/reset.
- `git reset --hard` может удалить tracked-изменения после явного подтверждения.

Добавлены безопасные guard-исправления:
- LAB блокирует PROD `container_name`.
- LAB блокирует запрещённые volume-имена `jkh_lab_mysql_data` и `jkh_mysql_data`.
- LAB требует существующее compose-volume имя `mysql_data`.
- PROD блокирует LAB `container_name`, LAB-порты, `DB_NAME=jkh_lab`, `ENV_TYPE=LAB` и LAB volume в `docker compose config`.
- `docker compose restart` и `docker compose up -d --build` теперь проходят общий guard выбранной среды.

## Проверенные маркеры

Найдено:
- LAB path: `scripts/jkh_server_menu_v5_3.sh:94` -> `/root/jkh-lab`
- PROD path: `scripts/jkh_server_menu_v5_3.sh:100` -> `/root/jkh`
- LAB MySQL container: `scripts/jkh_server_menu_v5_3.sh:96` -> `jkh_lab_mysql`
- PROD MySQL container: `scripts/jkh_server_menu_v5_3.sh:102` -> `jkh_mysql`
- `.env` path строится от выбранной среды: `scripts/jkh_server_menu_v5_3.sh:111`
- LAB compose self-heal: `scripts/jkh_server_menu_v5_3.sh:370`
- LAB compose file replacement: `scripts/jkh_server_menu_v5_3.sh:456`
- LAB guard: `scripts/jkh_server_menu_v5_3.sh:466`
- PROD guard: `scripts/jkh_server_menu_v5_3.sh:534`
- общий compose guard: `scripts/jkh_server_menu_v5_3.sh:585`
- Docker restart wrapper: `scripts/jkh_server_menu_v5_3.sh:597`
- Docker build wrapper: `scripts/jkh_server_menu_v5_3.sh:602`
- `git checkout`: `scripts/jkh_server_menu_v5_3.sh:1100`, `1126`, `1134`, `1147`, `1169`
- `git pull`: `scripts/jkh_server_menu_v5_3.sh:1101`, `1135`, `1170`
- `git reset --hard`: `scripts/jkh_server_menu_v5_3.sh:1127`, `1250`

Не найдено как исполняемая команда:
- `git clean`
- `docker compose down`
- `docker compose down -v`
- `docker volume`
- `docker volume rm`

## Находки

### 1. Разделение LAB/PROD путей и контейнеров

Статус: найдено, контролируется.
Файл и строки: `scripts/jkh_server_menu_v5_3.sh:94`, `96`, `100`, `102`, `111`.
Риск: LOW.

Объяснение:
Меню выбирает среду через `set_environment_vars`. Для LAB используется `/root/jkh-lab`, порт сайта `8080` и контейнер `jkh_lab_mysql`. Для PROD используется `/root/jkh`, сайт на `127.0.0.1/` и контейнер `jkh_mysql`. `.env` берётся из выбранного `PROJECT_DIR`.

Рекомендация:
Оставить текущую модель. Не передавать `PROJECT_DIR` извне без дополнительной проверки.

Нужно ли чинить сейчас:
Нет.

### 2. LAB self-heal перезаписывает docker-compose.yml

Статус: найдено.
Файл и строки: `scripts/jkh_server_menu_v5_3.sh:370`, `450`, `456`.
Риск: MEDIUM.

Объяснение:
В LAB после Git-операций меню может восстановить LAB `docker-compose.yml`. Это защищает LAB от PROD compose из ветки, но всё равно является записью в tracked-файл.

Рекомендация:
Оставить как осознанную LAB-защиту. Перед переносом в PROD добавить отдельный отчёт, что `docker-compose.yml` в LAB был self-healed и может отличаться от ветки.

Нужно ли чинить сейчас:
Нет, поведение требуется для LAB-стабилизации.

### 3. LAB может увидеть PROD compose

Статус: найдено и заблокировано.
Файл и строки: `scripts/jkh_server_menu_v5_3.sh:477`, `489`, `510`.
Риск до guard: HIGH.
Риск после guard: LOW.

Объяснение:
Если ветка приносит `container_name: jkh_nginx`, `jkh_mysql`, `jkh_api`, LAB мог бы запустить PROD-имена контейнеров. Guard теперь останавливает сценарий с ошибкой `LAB compose содержит PROD container_name. Deploy запрещён.`

Рекомендация:
Держать этот guard перед любым `docker compose restart` и `docker compose up -d --build`.

Нужно ли чинить сейчас:
Уже исправлено.

### 4. LAB volume должен быть mysql_data

Статус: найдено и заблокировано.
Файл и строки: `scripts/jkh_server_menu_v5_3.sh:412`, `441`, `483`, `502`, `520`.
Риск до guard: HIGH.
Риск после guard: LOW.

Объяснение:
Volume `jkh_lab_mysql_data` создаёт новый пустой Docker volume. Для рабочей LAB базы нужен compose volume `mysql_data`, который Docker разворачивает в существующий проектный volume LAB.

Рекомендация:
Оставить `mysql_data` в LAB compose и guard. Не возвращать `jkh_lab_mysql_data`.

Нужно ли чинить сейчас:
Уже исправлено.

### 5. PROD может увидеть LAB compose

Статус: найдено и заблокировано.
Файл и строки: `scripts/jkh_server_menu_v5_3.sh:534`, `545`, `557`, `564`.
Риск до guard: HIGH.
Риск после guard: LOW.

Объяснение:
Если в `/root/jkh` окажется LAB compose с `jkh_lab_*`, портами `8080/5001/3307`, `DB_NAME=jkh_lab` или `ENV_TYPE=LAB`, PROD-сценарий теперь остановится до Docker restart/build.

Рекомендация:
Оставить PROD guard. Если позже PROD compose станет отличаться по именам, расширять только allow/deny правила, не отключать guard.

Нужно ли чинить сейчас:
Уже исправлено.

### 6. docker compose restart/up/build

Статус: найдено, теперь обёрнуто guard.
Файл и строки: `scripts/jkh_server_menu_v5_3.sh:596`, `597`, `601`, `602`.
Риск: LOW.

Объяснение:
Реальные Docker restart/build вызовы находятся в обёртках `compose_restart` и `compose_up_build`. Перед ними вызывается `environment_compose_guard`.

Рекомендация:
Не добавлять прямые `run docker compose restart` или `run docker compose up -d --build` вне этих обёрток.

Нужно ли чинить сейчас:
Уже исправлено.

### 7. .env

Статус: найдено, только чтение.
Файл и строки: `scripts/jkh_server_menu_v5_3.sh:111`, `200`, `210`, `211`, `212`, `213`, `220`.
Риск: LOW.

Объяснение:
Меню читает `.env`, проверяет обязательные переменные и сравнивает `DB_PASSWORD` с `MYSQL_PASSWORD`. Записи в `.env` не найдено.

Рекомендация:
Оставить `.env` read-only. Если понадобится self-heal `.env`, делать отдельным пунктом с подтверждением.

Нужно ли чинить сейчас:
Нет.

### 8. git reset --hard

Статус: найдено.
Файл и строки: `scripts/jkh_server_menu_v5_3.sh:1127`, `1250`.
Риск: MEDIUM.

Объяснение:
`git reset --hard` может удалить локальные tracked-изменения. В пункте жёсткого возврата есть подтверждение `RESET_MAIN`; rollback требует отдельного подтверждения, а PROD требует backup и `YES_PROD`.

Рекомендация:
Оставить подтверждения. Для будущего улучшения можно добавить отдельный вывод `git diff --stat` прямо перед reset.

Нужно ли чинить сейчас:
Нет.

### 9. git clean / docker down / docker volume rm

Статус: не найдено как исполняемая команда.
Файл и строки: упоминания только в описаниях `scripts/jkh_server_menu_v5_3.sh:321`, `714`, `725`, `1214`, `1227`, `1228`.
Риск: LOW.

Объяснение:
Меню явно сообщает, что `git clean` и `docker compose down` не выполняются. Команд удаления Docker volumes не найдено.

Рекомендация:
Не добавлять `docker compose down -v`, `docker volume rm` или `git clean` в это меню.

Нужно ли чинить сейчас:
Нет.

### 10. Локальные незакоммиченные изменения

Статус: найдено, частично контролируется.
Файл и строки: `scripts/jkh_server_menu_v5_3.sh:303`, `321`, `1127`, `1250`.
Риск: MEDIUM.

Объяснение:
Перед deploy есть `confirm_worktree_changes`, но `git reset --hard` всё равно может стереть tracked-изменения после подтверждения. Untracked-файлы не удаляются.

Рекомендация:
Оставить подтверждение. Улучшение на будущее: перед reset печатать конкретный список tracked-файлов, которые будут потеряны.

Нужно ли чинить сейчас:
Нет.

## CRITICAL-план

CRITICAL-риски не найдены. Отдельный план исправления не требуется.
