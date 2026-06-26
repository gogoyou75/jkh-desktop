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
- Добавлен пункт 16 `Backup текущей среды`: dump MySQL выбранной среды в `/root/backups`, без restore, docker down, Git-изменений и правки compose.
- Пункт 15 заменён на read-only LAB -> PROD preflight без merge/deploy/backup/reset/изменения веток.
- Добавлен пункт 17 `LAB -> PROD Deploy Wizard`: мастер-инструкция без автоматического deploy и без изменений.
- LAB блокирует PROD `container_name`.
- LAB блокирует запрещённые volume-имена `jkh_lab_mysql_data` и `jkh_mysql_data`.
- LAB требует существующее compose-volume имя `mysql_data`.
- PROD блокирует LAB `container_name`, LAB-порты, `DB_NAME=jkh_lab`, `ENV_TYPE=LAB` и LAB volume в `docker compose config`.
- `docker compose restart` и `docker compose up -d --build` теперь проходят общий guard выбранной среды.

## Проверенные маркеры

Найдено:
- LAB path: `scripts/jkh_server_menu_v5_3.sh:115` -> `/root/jkh-lab`
- PROD path: `scripts/jkh_server_menu_v5_3.sh:121` -> `/root/jkh`
- LAB MySQL container: `scripts/jkh_server_menu_v5_3.sh:117` -> `jkh_lab_mysql`
- PROD MySQL container: `scripts/jkh_server_menu_v5_3.sh:123` -> `jkh_mysql`
- `.env` path строится от выбранной среды: `scripts/jkh_server_menu_v5_3.sh:132`
- Backup текущей среды: `scripts/jkh_server_menu_v5_3.sh:377`
- LAB compose self-heal: `scripts/jkh_server_menu_v5_3.sh:483`
- LAB compose file replacement: `scripts/jkh_server_menu_v5_3.sh:569`
- LAB guard: `scripts/jkh_server_menu_v5_3.sh:579`
- PROD guard: `scripts/jkh_server_menu_v5_3.sh:647`
- environment guard: `scripts/jkh_server_menu_v5_3.sh:698`
- общий compose guard: `scripts/jkh_server_menu_v5_3.sh:724`
- Docker restart wrapper: `scripts/jkh_server_menu_v5_3.sh:735`
- Docker build wrapper: `scripts/jkh_server_menu_v5_3.sh:740`
- LAB запрет main-сценариев: `scripts/jkh_server_menu_v5_3.sh:429`
- PROD branch guard для main-сценариев: `scripts/jkh_server_menu_v5_3.sh:439`
- Cherry-pick source branch выбор: `scripts/jkh_server_menu_v5_3.sh:1145`
- Cherry-pick hash validation: `scripts/jkh_server_menu_v5_3.sh:1220`
- Cherry-pick commit выбор: `scripts/jkh_server_menu_v5_3.sh:1248`
- LAB -> PROD preflight: `scripts/jkh_server_menu_v5_3.sh:1487`
- пункт 3 `Main с build`: `scripts/jkh_server_menu_v5_3.sh:1629`
- пункт 11 `Cherry-pick одного коммита`: `scripts/jkh_server_menu_v5_3.sh:1679`
- `git checkout`: `scripts/jkh_server_menu_v5_3.sh:1594`, `1622`, `1632`, `1646`, `1669`
- `git pull`: `scripts/jkh_server_menu_v5_3.sh:1595`, `1633`, `1670`
- `git reset --hard`: `scripts/jkh_server_menu_v5_3.sh:1623`, `1783`

## Правильный поток LAB -> PROD

Правило:
- PROD deploy разрешён только из `main`.
- LAB-ветка не выкатывается напрямую в PROD.
- Правильный поток: LAB branch -> проверки -> merge в `main` -> PROD backup -> deploy `main` -> health-check.

Пункт 15 только проверяет готовность и не переносит код. Пункт 16 делает только backup текущей среды и не выполняет restore.

Не найдено как исполняемая команда:
- `git clean`
- `docker compose down`
- `docker compose down -v`
- `docker volume`
- `docker volume rm`

## Находки

### 0. LAB пункт 3 `Main с build` оставляет LAB на main и dirty compose

Статус: найдено практической проверкой и заблокировано.
Файл и строки: `scripts/jkh_server_menu_v5_3.sh:429`, `1629`.
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
Файл и строки: `scripts/jkh_server_menu_v5_3.sh:115`, `117`, `121`, `123`, `132`.
Риск: LOW.

Объяснение:
Меню выбирает среду через `set_environment_vars`. Для LAB используется `/root/jkh-lab`, порт сайта `8080` и контейнер `jkh_lab_mysql`. Для PROD используется `/root/jkh`, сайт на `127.0.0.1/` и контейнер `jkh_mysql`. `.env` берётся из выбранного `PROJECT_DIR`.

Рекомендация:
Оставить текущую модель. Не передавать `PROJECT_DIR` извне без дополнительной проверки.

Нужно ли чинить сейчас:
Нет.

### 2. LAB self-heal перезаписывает docker-compose.yml

Статус: найдено.
Файл и строки: `scripts/jkh_server_menu_v5_3.sh:483`, `563`, `569`.
Риск: MEDIUM.

Объяснение:
В LAB после Git-операций меню может восстановить LAB `docker-compose.yml`. Это защищает LAB от PROD compose из ветки, но всё равно является записью в tracked-файл.

Рекомендация:
Оставить как осознанную LAB-защиту. Перед переносом в PROD добавить отдельный отчёт, что `docker-compose.yml` в LAB был self-healed и может отличаться от ветки.

Нужно ли чинить сейчас:
Нет, поведение требуется для LAB-стабилизации.

### 3. LAB может увидеть PROD compose

Статус: найдено и заблокировано.
Файл и строки: `scripts/jkh_server_menu_v5_3.sh:590`, `602`, `623`.
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
Файл и строки: `scripts/jkh_server_menu_v5_3.sh:525`, `554`, `596`, `615`, `633`.
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
Файл и строки: `scripts/jkh_server_menu_v5_3.sh:647`, `658`, `670`, `677`.
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
Файл и строки: `scripts/jkh_server_menu_v5_3.sh:735`, `736`, `740`, `741`.
Риск: LOW.

Объяснение:
Реальные Docker restart/build вызовы находятся в обёртках `compose_restart` и `compose_up_build`. Перед ними вызывается `environment_compose_guard`.

Рекомендация:
Не добавлять прямые `run docker compose restart` или `run docker compose up -d --build` вне этих обёрток.

Нужно ли чинить сейчас:
Уже исправлено.

### 7. .env

Статус: найдено, только чтение.
Файл и строки: `scripts/jkh_server_menu_v5_3.sh:132`, `221`, `231`, `232`, `233`, `234`, `241`.
Риск: LOW.

Объяснение:
Меню читает `.env`, проверяет обязательные переменные и сравнивает `DB_PASSWORD` с `MYSQL_PASSWORD`. Записи в `.env` не найдено.

Рекомендация:
Оставить `.env` read-only. Если понадобится self-heal `.env`, делать отдельным пунктом с подтверждением.

Нужно ли чинить сейчас:
Нет.

### 8. git reset --hard

Статус: найдено.
Файл и строки: `scripts/jkh_server_menu_v5_3.sh:1623`, `1783`.
Риск: MEDIUM.

Объяснение:
`git reset --hard` может удалить локальные tracked-изменения. В пункте жёсткого возврата есть подтверждение `RESET_MAIN`; rollback требует отдельного подтверждения, а PROD требует backup и `YES_PROD`.

Рекомендация:
Оставить подтверждения. Для будущего улучшения можно добавить отдельный вывод `git diff --stat` прямо перед reset.

Нужно ли чинить сейчас:
Нет.

### 9. git clean / docker down / docker volume rm

Статус: не найдено как исполняемая команда.
Файл и строки: упоминания только в описаниях `scripts/jkh_server_menu_v5_3.sh:342`, `845`, `867`, `1747`, `1760`, `1761`.
Риск: LOW.

Объяснение:
Меню явно сообщает, что `git clean` и `docker compose down` не выполняются. Команд удаления Docker volumes не найдено.

Рекомендация:
Не добавлять `docker compose down -v`, `docker volume rm` или `git clean` в это меню.

Нужно ли чинить сейчас:
Нет.

### 10. Локальные незакоммиченные изменения

Статус: найдено, частично контролируется.
Файл и строки: `scripts/jkh_server_menu_v5_3.sh:327`, `342`, `1623`, `1783`.
Риск: MEDIUM.

Объяснение:
Перед deploy есть `confirm_worktree_changes`, но `git reset --hard` всё равно может стереть tracked-изменения после подтверждения. Untracked-файлы не удаляются.

Рекомендация:
Оставить подтверждение. Улучшение на будущее: перед reset печатать конкретный список tracked-файлов, которые будут потеряны.

Нужно ли чинить сейчас:
Нет.

### 11. Cherry-pick принимал произвольный commit hash

Статус: найдено практической проверкой и заблокировано.
Файл и строки: `scripts/jkh_server_menu_v5_3.sh:1145`, `1220`, `1248`, `1679`.
Риск до guard: MEDIUM/HIGH.
Риск после guard: LOW.

Объяснение:
При запуске пункта 11 в LAB меню просило `Хеш коммита`. Ввод `hello world` сразу попадал в `git show --stat hello world`, Git возвращал `fatal: ambiguous argument`, а сценарий завершался ERROR. Git и Docker не ломались, но UX был небезопасным: произвольный текст доходил до Git-команд без предварительной проверки и без понятного BLOCKED-сообщения.

Повторная практическая проверка после первой правки показала, что на сервере пункт 11 всё ещё шёл по старому UX: меню снова показывало `Хеш коммита`, ввод `hello papa` доходил до `git show --stat hello papa` и завершался ERROR. Причина аудита: первая правка не заменила активный путь обработчика сценария 11 на сервере, поэтому потребовалась повторная проверка всех вхождений `Хеш коммита`, `git show --stat`, `cherry-pick`, `case 11` и функции, реально вызываемой из `run_case`.

Исправление:
Пункт 11 теперь показывает текущую ветку, commit, upstream и среду, затем требует чистый `git status`, проходит compose/environment guard и branch guard. Source branch выбирается из списка `origin/*`; ручной ввод ветки доступен только после подтверждения `MANUAL_BRANCH`. После `git fetch origin` меню показывает последние 20 коммитов выбранной ветки и даёт выбрать commit номером. Ручной hash доступен только через отдельный режим `MANUAL_HASH`, затем проверяется regex `^[0-9a-fA-F]{7,40}$` и `git cat-file -e <hash>^{commit}`; при ошибке выводится `BLOCKED: невалидный commit hash`.

Build после успешного cherry-pick больше не запускается автоматически: меню сначала показывает `git status`, новый `HEAD`, затем отдельно спрашивает подтверждение build. При конфликте build не выполняется, показывается `BLOCKED: cherry-pick требует ручного разрешения конфликта` и команды `git cherry-pick --abort`, `git status -sb`.

Дополнительный UX-риск LOW/MEDIUM найден практической проверкой: если выбранный commit уже входит в текущую ветку, `git cherry-pick` возвращал empty cherry-pick (`previous cherry-pick is now empty`), а меню ошибочно показывало конфликт. Исправление: перед cherry-pick выполняется `git merge-base --is-ancestor <commit> HEAD`; уже применённые коммиты помечаются `[ALREADY IN CURRENT BRANCH]` в списке, новые - `[NEW]`. При выборе уже применённого commit меню останавливается с `BLOCKED: этот commit уже есть в текущей ветке`, не запускает cherry-pick/build и не предлагает `git cherry-pick --abort`.

Повторная проверка показала, что кейс `selected commit == HEAD` всё ещё доходил до `git show` и `git cherry-pick`. Guard усилен: выбранный commit и `HEAD` сначала нормализуются через `git rev-parse --verify <rev>^{commit}`, затем явно сравниваются на равенство, и только после этого выполняется `git merge-base --is-ancestor`. Это блокирует exact-HEAD до `git show --stat` и до вопроса `Применить этот коммит?`.

Рекомендация:
Оставить cherry-pick только через выбор ветки и commit из списка. Ручной hash использовать как аварийный режим с текущей валидацией.

Нужно ли чинить сейчас:
Уже исправлено.

### 12. Backup текущей среды

Статус: добавлено.
Риск: MEDIUM для LAB, HIGH для PROD без подтверждения; после guard риск LOW/MEDIUM.

Объяснение:
Пункт 16 создаёт только MySQL dump текущей выбранной среды в `/root/backups`. Для LAB используется container `jkh_lab_mysql`, база `jkh_lab`, файл `lab_backup_YYYY-MM-DD_HH-MM-SS.sql`. Для PROD используется container `jkh_mysql`, база `jkh`, файл `prod_backup_YYYY-MM-DD_HH-MM-SS.sql`, перед выполнением требуется `YES_PROD`.

Guard:
Backup выполняет `mkdir -p /root/backups`, `mysqldump` внутри нужного контейнера и `ls -lh` созданного файла. Если файл пустой, сценарий завершается ERROR. Restore, `docker compose down`, Git-операции, изменение `docker-compose.yml`, БД-миграции и Docker volumes не выполняются.

Рекомендация:
Использовать пункт 16 перед PROD deploy и перед рискованными ручными действиями. Restore должен оставаться отдельной процедурой вне этого меню.

Нужно ли чинить сейчас:
Уже добавлено.

### 13. LAB -> PROD preflight

Статус: заглушка заменена на read-only preflight.
Риск: LOW.

Объяснение:
Пункт 15 читает состояние LAB и PROD: текущую ветку, `git status`, последний commit, health сайта/API, sha256sum `web/calc_engine.js`, наличие `scripts/jkh_server_menu_v5_3.sh`, `docker compose ps`. Он не делает merge, deploy, backup, reset, checkout, запись файлов или изменение БД.

Итог:
Если проверка не нашла причин блокировки, выводится `READY: можно готовить merge в main`. Если есть проблемы, выводится `BLOCKED: список причин`.

Правило переноса:
LAB-ветка не выкатывается напрямую в PROD. Сначала проверка LAB branch, затем merge в `main`, затем PROD backup, deploy `main`, health-check.

Нужно ли чинить сейчас:
Уже добавлено.

### 14. LAB -> PROD Deploy Wizard

Статус: добавлено.
Риск: LOW.

Объяснение:
Пункт 17 является мастер-инструкцией, а не автоматическим deploy. Он читает LAB-контекст: среду, папку, ветку, upstream, HEAD, `git status -sb`, health LAB site/API. Затем определяет source branch из upstream, показывает схему `LAB server branch test-pr -> GitHub branch codex/... -> merge into main on GitHub -> PROD server deploy from main` и выводит ручные шаги.

Пункт 17 не заменяет пункт 15: wizard не запускает `docker compose`, поэтому окончательный READY должен быть получен через пункт 15. Если wizard уже видит причины блокировки из Git/файлов/health, он показывает `Сначала исправь причины пункта 15. Merge/deploy пока нельзя.` и не выводит deploy как следующий шаг.

Запреты:
Пункт 17 не делает `git checkout`, `git reset`, `git merge`, `git push`, `docker compose`, backup, deploy, запись файлов или изменение БД. Он также явно напоминает, что нельзя переключать LAB-сервер в `main`, нельзя деплоить PROD напрямую из `codex/*`, нельзя копировать файлы LAB -> PROD руками, нельзя переносить LAB-базу в PROD, нельзя делать restore LAB backup в PROD и нельзя менять `docker-compose.yml` вручную ради релиза.

Правило релиза:
GitHub `main` является релизной точкой. PROD deploy выполняется только из `main`; LAB-сервер остаётся на тестовой ветке. Правильный поток: пункт 15 READY -> merge source branch в `main` через GitHub -> пункт 16 backup PROD -> deploy PROD из `main` -> health-check PROD.

Нужно ли чинить сейчас:
Уже добавлено.

## CRITICAL-план

CRITICAL-риски не найдены. Отдельный план исправления не требуется.
