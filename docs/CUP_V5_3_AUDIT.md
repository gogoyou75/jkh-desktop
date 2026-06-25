# CUP v5.3 LAB/PROD safety audit

Дата аудита: 2026-06-25
Ветка: `codex/stage19-final-razriv-i`
Проверенный файл: `scripts/jkh_server_menu_v5_3.sh`

## Итог

CRITICAL-риски: не найдено.

Найден HIGH-риск практической проверкой и исправлен:
- LAB пункт 3 `Main с build` мог переключить рабочую копию на `main`, выполнить `git pull origin main`, восстановить LAB `docker-compose.yml`, выполнить `docker compose up -d --build`, завершиться SUCCESS и оставить LAB на ветке `main` с `M docker-compose.yml`.
- Пункт 11 `Cherry-pick одного коммита` принимал произвольный текст как commit hash и доходил до `git show --stat`, что давало плохой UX и ошибку Git вместо безопасной блокировки.

Найдены MEDIUM-риски, которые являются осознанным поведением меню:
- LAB self-heal может перезаписать `docker-compose.yml` после Git checkout/pull/reset.
- `git reset --hard` может удалить tracked-изменения после явного подтверждения.

Добавлены безопасные guard-исправления:
- Main-сценарии в LAB запрещены до любых Git/Docker/self-heal действий. Для LAB нужно использовать пункты 4/5 с тестовой веткой.
- PROD main-сценарии требуют `YES_PROD`, backup MySQL, environment guard и branch guard `main == origin/main`.
- Cherry-pick теперь выбирает source branch из `origin/*`, показывает последние 20 коммитов, выбирает commit номером, валидирует ручной hash и запускает build только после второго подтверждения.
- LAB блокирует PROD `container_name`.
- LAB блокирует запрещённые volume-имена `jkh_lab_mysql_data` и `jkh_mysql_data`.
- LAB требует существующее compose-volume имя `mysql_data`.
- PROD блокирует LAB `container_name`, LAB-порты, `DB_NAME=jkh_lab`, `ENV_TYPE=LAB` и LAB volume в `docker compose config`.
- `docker compose restart` и `docker compose up -d --build` теперь проходят общий guard выбранной среды.

## Проверенные маркеры

Найдено:
- LAB path: `scripts/jkh_server_menu_v5_3.sh:114` -> `/root/jkh-lab`
- PROD path: `scripts/jkh_server_menu_v5_3.sh:120` -> `/root/jkh`
- LAB MySQL container: `scripts/jkh_server_menu_v5_3.sh:116` -> `jkh_lab_mysql`
- PROD MySQL container: `scripts/jkh_server_menu_v5_3.sh:122` -> `jkh_mysql`
- `.env` path строится от выбранной среды: `scripts/jkh_server_menu_v5_3.sh:131`
- LAB compose self-heal: `scripts/jkh_server_menu_v5_3.sh:430`
- LAB compose file replacement: `scripts/jkh_server_menu_v5_3.sh:516`
- LAB guard: `scripts/jkh_server_menu_v5_3.sh:526`
- PROD guard: `scripts/jkh_server_menu_v5_3.sh:594`
- environment guard: `scripts/jkh_server_menu_v5_3.sh:645`
- общий compose guard: `scripts/jkh_server_menu_v5_3.sh:671`
- Docker restart wrapper: `scripts/jkh_server_menu_v5_3.sh:682`
- Docker build wrapper: `scripts/jkh_server_menu_v5_3.sh:687`
- LAB запрет main-сценариев: `scripts/jkh_server_menu_v5_3.sh:376`
- PROD branch guard для main-сценариев: `scripts/jkh_server_menu_v5_3.sh:386`
- Cherry-pick source branch выбор: `scripts/jkh_server_menu_v5_3.sh:1081`
- Cherry-pick hash validation: `scripts/jkh_server_menu_v5_3.sh:1156`
- Cherry-pick commit выбор: `scripts/jkh_server_menu_v5_3.sh:1170`
- пункт 3 `Main с build`: `scripts/jkh_server_menu_v5_3.sh:1422`
- пункт 11 `Cherry-pick одного коммита`: `scripts/jkh_server_menu_v5_3.sh:1471`
- `git checkout`: `scripts/jkh_server_menu_v5_3.sh:1386`, `1414`, `1424`, `1438`, `1461`
- `git pull`: `scripts/jkh_server_menu_v5_3.sh:1387`, `1425`, `1462`
- `git reset --hard`: `scripts/jkh_server_menu_v5_3.sh:1415`, `1570`

Не найдено как исполняемая команда:
- `git clean`
- `docker compose down`
- `docker compose down -v`
- `docker volume`
- `docker volume rm`

## Находки

### 0. LAB пункт 3 `Main с build` оставляет LAB на main и dirty compose

Статус: найдено практической проверкой и заблокировано.
Файл и строки: `scripts/jkh_server_menu_v5_3.sh:376`, `1422`.
Риск до guard: HIGH.
Риск после guard: LOW.

Объяснение:
При запуске пункта 3 в LAB сценарий переключал рабочую копию с `test-pr` на `main`, выполнял `git pull origin main`, восстанавливал LAB `docker-compose.yml`, запускал `docker compose up -d --build`, завершался SUCCESS, но оставлял LAB на ветке `main` и с `M docker-compose.yml`. Это неверно для LAB-аудита: LAB должен оставаться на тестовой ветке, а main-сценарии не должны менять состояние LAB.

Исправление:
Добавлен guard `require_main_scenario_prod`: main-сценарии в LAB завершаются сообщением `Main-сценарии в LAB запрещены. Используй пункт 4/5 для тестовой ветки.` до `prepare_deploy`, `git checkout`, `git pull`, LAB self-heal и Docker. Для PROD добавлен `prod_main_branch_guard`, проверяющий ветку `main` и соответствие `HEAD == origin/main` перед Docker-действиями.

Рекомендация:
Оставить пункт 3 заблокированным в LAB. Для LAB-аудита использовать только пункты 4/5 с `test-pr` и выбранной веткой.

Нужно ли чинить сейчас:
Уже исправлено.

### 1. Разделение LAB/PROD путей и контейнеров

Статус: найдено, контролируется.
Файл и строки: `scripts/jkh_server_menu_v5_3.sh:114`, `116`, `120`, `122`, `131`.
Риск: LOW.

Объяснение:
Меню выбирает среду через `set_environment_vars`. Для LAB используется `/root/jkh-lab`, порт сайта `8080` и контейнер `jkh_lab_mysql`. Для PROD используется `/root/jkh`, сайт на `127.0.0.1/` и контейнер `jkh_mysql`. `.env` берётся из выбранного `PROJECT_DIR`.

Рекомендация:
Оставить текущую модель. Не передавать `PROJECT_DIR` извне без дополнительной проверки.

Нужно ли чинить сейчас:
Нет.

### 2. LAB self-heal перезаписывает docker-compose.yml

Статус: найдено.
Файл и строки: `scripts/jkh_server_menu_v5_3.sh:430`, `510`, `516`.
Риск: MEDIUM.

Объяснение:
В LAB после Git-операций меню может восстановить LAB `docker-compose.yml`. Это защищает LAB от PROD compose из ветки, но всё равно является записью в tracked-файл.

Рекомендация:
Оставить как осознанную LAB-защиту. Перед переносом в PROD добавить отдельный отчёт, что `docker-compose.yml` в LAB был self-healed и может отличаться от ветки.

Нужно ли чинить сейчас:
Нет, поведение требуется для LAB-стабилизации.

### 3. LAB может увидеть PROD compose

Статус: найдено и заблокировано.
Файл и строки: `scripts/jkh_server_menu_v5_3.sh:537`, `549`, `570`.
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
Файл и строки: `scripts/jkh_server_menu_v5_3.sh:472`, `501`, `543`, `562`, `580`.
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
Файл и строки: `scripts/jkh_server_menu_v5_3.sh:594`, `605`, `617`, `624`.
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
Файл и строки: `scripts/jkh_server_menu_v5_3.sh:682`, `683`, `687`, `688`.
Риск: LOW.

Объяснение:
Реальные Docker restart/build вызовы находятся в обёртках `compose_restart` и `compose_up_build`. Перед ними вызывается `environment_compose_guard`.

Рекомендация:
Не добавлять прямые `run docker compose restart` или `run docker compose up -d --build` вне этих обёрток.

Нужно ли чинить сейчас:
Уже исправлено.

### 7. .env

Статус: найдено, только чтение.
Файл и строки: `scripts/jkh_server_menu_v5_3.sh:131`, `220`, `230`, `231`, `232`, `233`, `240`.
Риск: LOW.

Объяснение:
Меню читает `.env`, проверяет обязательные переменные и сравнивает `DB_PASSWORD` с `MYSQL_PASSWORD`. Записи в `.env` не найдено.

Рекомендация:
Оставить `.env` read-only. Если понадобится self-heal `.env`, делать отдельным пунктом с подтверждением.

Нужно ли чинить сейчас:
Нет.

### 8. git reset --hard

Статус: найдено.
Файл и строки: `scripts/jkh_server_menu_v5_3.sh:1415`, `1570`.
Риск: MEDIUM.

Объяснение:
`git reset --hard` может удалить локальные tracked-изменения. В пункте жёсткого возврата есть подтверждение `RESET_MAIN`; rollback требует отдельного подтверждения, а PROD требует backup и `YES_PROD`.

Рекомендация:
Оставить подтверждения. Для будущего улучшения можно добавить отдельный вывод `git diff --stat` прямо перед reset.

Нужно ли чинить сейчас:
Нет.

### 9. git clean / docker down / docker volume rm

Статус: не найдено как исполняемая команда.
Файл и строки: упоминания только в описаниях `scripts/jkh_server_menu_v5_3.sh:341`, `792`, `814`, `1534`, `1547`, `1548`.
Риск: LOW.

Объяснение:
Меню явно сообщает, что `git clean` и `docker compose down` не выполняются. Команд удаления Docker volumes не найдено.

Рекомендация:
Не добавлять `docker compose down -v`, `docker volume rm` или `git clean` в это меню.

Нужно ли чинить сейчас:
Нет.

### 10. Локальные незакоммиченные изменения

Статус: найдено, частично контролируется.
Файл и строки: `scripts/jkh_server_menu_v5_3.sh:326`, `341`, `1415`, `1570`.
Риск: MEDIUM.

Объяснение:
Перед deploy есть `confirm_worktree_changes`, но `git reset --hard` всё равно может стереть tracked-изменения после подтверждения. Untracked-файлы не удаляются.

Рекомендация:
Оставить подтверждение. Улучшение на будущее: перед reset печатать конкретный список tracked-файлов, которые будут потеряны.

Нужно ли чинить сейчас:
Нет.

### 11. Cherry-pick принимал произвольный commit hash

Статус: найдено практической проверкой и заблокировано.
Файл и строки: `scripts/jkh_server_menu_v5_3.sh:1081`, `1156`, `1170`, `1471`.
Риск до guard: MEDIUM/HIGH.
Риск после guard: LOW.

Объяснение:
При запуске пункта 11 в LAB меню просило `Хеш коммита`. Ввод `hello world` сразу попадал в `git show --stat hello world`, Git возвращал `fatal: ambiguous argument`, а сценарий завершался ERROR. Git и Docker не ломались, но UX был небезопасным: произвольный текст доходил до Git-команд без предварительной проверки и без понятного BLOCKED-сообщения.

Исправление:
Пункт 11 теперь показывает текущую ветку, commit, upstream и среду, затем требует чистый `git status`, проходит compose/environment guard и branch guard. Source branch выбирается из списка `origin/*`; ручной ввод ветки доступен только после подтверждения `MANUAL_BRANCH`. После `git fetch origin` меню показывает последние 20 коммитов выбранной ветки и даёт выбрать commit номером. Ручной hash разрешён только после regex `^[0-9a-fA-F]{7,40}$` и `git cat-file -e <hash>^{commit}`; при ошибке выводится `BLOCKED: невалидный commit hash`.

Build после успешного cherry-pick больше не запускается автоматически: меню сначала показывает `git status`, новый `HEAD`, затем отдельно спрашивает подтверждение build. При конфликте build не выполняется, показывается `BLOCKED: cherry-pick требует ручного разрешения конфликта` и команды `git cherry-pick --abort`, `git status -sb`.

Рекомендация:
Оставить cherry-pick только через выбор ветки и commit из списка. Ручной hash использовать как аварийный режим с текущей валидацией.

Нужно ли чинить сейчас:
Уже исправлено.

## CRITICAL-план

CRITICAL-риски не найдены. Отдельный план исправления не требуется.
