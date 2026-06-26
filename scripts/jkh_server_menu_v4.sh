#!/usr/bin/env bash
# ============================================================
# JKH SERVER DEPLOY MENU v4.2 (SUCCESS / ERROR)
# ============================================================
# Что делает:
# - показывает описание перед запуском
# - после операции показывает текущую ветку
# - показывает docker compose ps
# - выбор тестовой ветки теперь показывает все origin/* ветки, не только origin/codex/*
# - проверяет главную страницу nginx
# - добавляет финальную техническую проверку перед merge/deploy: tests + syntax + calc_engine guard
# - крупно пишет SUCCESS или ERROR
#
# ВАЖНО:
# - main = эталонная ветка
# - reset --hard удаляет локальные изменения на сервере
# - --build использовать только при изменении Dockerfile / requirements.txt / backend-зависимостей
# ============================================================

set -u

PROJECT_DIR="/root/jkh"
ENV_FILE="$PROJECT_DIR/.env"
LAST_ERROR=0

print_line() {
  echo "============================================================"
}

success() {
  echo
  print_line
  echo "✅ SUCCESS: операция завершена"
  print_line
}

fail() {
  echo
  print_line
  echo "❌ ERROR: операция НЕ завершена"
  echo "Смотри сообщение об ошибке выше."
  print_line
}

run() {
  echo
  echo ">>> $*"
  "$@"
  local code=$?
  if [ $code -ne 0 ]; then
    echo "ОШИБКА команды: $*"
    echo "Код ошибки: $code"
    LAST_ERROR=$code
    return $code
  fi
  return 0
}

go_project() {
  if [ ! -d "$PROJECT_DIR" ]; then
    echo "ОШИБКА: папка проекта не найдена: $PROJECT_DIR"
    LAST_ERROR=1
    return 1
  fi

  cd "$PROJECT_DIR" || {
    echo "ОШИБКА: не удалось перейти в $PROJECT_DIR"
    LAST_ERROR=1
    return 1
  }

  if [ ! -d ".git" ]; then
    echo "ОШИБКА: $PROJECT_DIR не является git-репозиторием"
    LAST_ERROR=1
    return 1
  fi
}


load_env() {
  if [ ! -f "$ENV_FILE" ]; then
    echo "ОШИБКА: не найден файл .env: $ENV_FILE"
    LAST_ERROR=1
    return 1
  fi

  set -a
  . "$ENV_FILE"
  set +a

  : "${MYSQL_ROOT_PASSWORD:?ОШИБКА: в .env нет MYSQL_ROOT_PASSWORD}"
  : "${MYSQL_DATABASE:?ОШИБКА: в .env нет MYSQL_DATABASE}"
  : "${MYSQL_USER:?ОШИБКА: в .env нет MYSQL_USER}"
  : "${MYSQL_PASSWORD:?ОШИБКА: в .env нет MYSQL_PASSWORD}"

  DB_NAME_EFFECTIVE="${DB_NAME:-$MYSQL_DATABASE}"
  DB_USER_EFFECTIVE="${DB_USER:-$MYSQL_USER}"
  DB_PASSWORD_EFFECTIVE="${DB_PASSWORD:-$MYSQL_PASSWORD}"

  if [ "$DB_PASSWORD_EFFECTIVE" != "$MYSQL_PASSWORD" ]; then
    echo "ОШИБКА: DB_PASSWORD и MYSQL_PASSWORD в .env отличаются."
    LAST_ERROR=1
    return 1
  fi
}

mysql_root_dump() {
  local backup_file="$1"
  docker exec -e MYSQL_PWD="$MYSQL_ROOT_PASSWORD" jkh_mysql mysqldump -u root "$DB_NAME_EFFECTIVE" > "$backup_file"
}

mysql_app_check() {
  docker exec -e MYSQL_PWD="$DB_PASSWORD_EFFECTIVE" jkh_mysql mysql -u "$DB_USER_EFFECTIVE" "$DB_NAME_EFFECTIVE" -e "SELECT 1;"
}

pause() {
  echo
  read -rp "Нажми Enter для возврата в меню..."
}

show_final_status() {
  echo
  print_line
  echo "ИТОГОВАЯ ПРОВЕРКА"
  print_line

  echo
  echo "Папка:"
  pwd

  echo
  echo "Текущая ветка:"
  git branch --show-current || true

  echo
  echo "Git status:"
  git status -sb || true

  echo
  echo "Последние коммиты:"
  git log --oneline -n 3 || true

  echo
  echo "Docker containers:"
  docker compose ps || true

  echo
  echo "Проверка nginx / главной страницы:"
  curl -I -s http://127.0.0.1/ | head -n 1 || true

  echo
}

check_result() {
  if [ "$LAST_ERROR" -eq 0 ]; then
    success
  else
    fail
  fi
}

explain() {
  print_line
  case "$1" in
    1)
      echo "СЦЕНАРИЙ 1: ОБЫЧНОЕ ОБНОВЛЕНИЕ MAIN"
      echo
      echo "Когда использовать:"
      echo "- после merge в main"
      echo "- обычное обновление сервера"
      echo
      echo "Что будет сделано:"
      echo "git checkout main"
      echo "git pull origin main"
      echo "docker compose restart"
      ;;
    2)
      echo "СЦЕНАРИЙ 2: ЖЁСТКИЙ ВОЗВРАТ НА ЧИСТЫЙ MAIN"
      echo
      echo "Когда использовать:"
      echo "- сервер ведёт себя странно"
      echo "- надо сделать сервер точной копией GitHub main"
      echo
      echo "Что будет сделано:"
      echo "git fetch origin"
      echo "git checkout main"
      echo "git reset --hard origin/main"
      echo "docker compose restart"
      echo
      echo "ВНИМАНИЕ: локальные изменения на сервере будут удалены."
      ;;
    3)
      echo "СЦЕНАРИЙ 3: MAIN С ПЕРЕСБОРКОЙ"
      echo
      echo "Когда использовать:"
      echo "- менялся Dockerfile"
      echo "- менялся requirements.txt"
      echo "- менялись backend-зависимости"
      echo
      echo "Что будет сделано:"
      echo "git checkout main"
      echo "git pull origin main"
      echo "docker compose up -d --build"
      ;;
    4)
      echo "СЦЕНАРИЙ 4: ТЕСТОВАЯ ВЕТКА С BUILD"
      echo
      echo "Когда использовать:"
      echo "- проверка PR/Codex ветки"
      echo "- серьёзные изменения backend/import/storage"
      echo
      echo "Что будет сделано:"
      echo "выбор любой remote-ветки origin/... из списка"
      echo "git checkout -B test-pr origin/ВЕТКА"
      echo "docker compose up -d --build"
      ;;
    5)
      echo "СЦЕНАРИЙ 5: ТЕСТОВАЯ ВЕТКА БЫСТРО, БЕЗ BUILD"
      echo
      echo "Когда использовать:"
      echo "- проверить UI/HTML/JS"
      echo "- нет изменений Dockerfile/requirements"
      echo
      echo "Что будет сделано:"
      echo "выбор любой remote-ветки origin/... из списка"
      echo "git checkout -B test-pr origin/ВЕТКА"
      echo "docker compose restart"
      ;;
    6)
      echo "СЦЕНАРИЙ 6: ТОЛЬКО RESTART"
      echo
      echo "Когда использовать:"
      echo "- просто перезапустить контейнеры"
      echo "- код уже на месте"
      echo
      echo "Что будет сделано:"
      echo "docker compose restart"
      ;;
    7)
      echo "СЦЕНАРИЙ 7: ТОЛЬКО ПРОВЕРКИ"
      echo
      echo "Когда использовать:"
      echo "- понять, где ты сейчас"
      echo "- проверить ветку, контейнеры и nginx"
      ;;
    8)
      echo "СЦЕНАРИЙ 8: ЛОГИ"
      echo
      echo "Когда использовать:"
      echo "- сайт не работает"
      echo "- контейнеры есть, но ошибка внутри"
      ;;
    9)
      echo "СЦЕНАРИЙ 9: БЕЗОПАСНОЕ ОБНОВЛЕНИЕ MAIN"
      echo
      echo "Когда использовать:"
      echo "- перед важным обновлением main"
      echo "- когда уже внесены реальные данные и нельзя рисковать базой"
      echo
      echo "Что будет сделано:"
      echo "1) пароли будут прочитаны из /root/jkh/.env"
      echo "2) создастся backup MySQL"
      echo "3) backup будет проверен на ненулевой размер"
      echo "4) будет проверен доступ к MySQL пользователем jkh"
      echo "5) будет проверен API через /api/auth/me"
      echo "6) git checkout main"
      echo "7) git pull origin main"
      echo "8) docker compose up -d --build"
      echo "9) финальная проверка MySQL и API"
      ;;
    10)
      echo "СЦЕНАРИЙ 10: ФИНАЛЬНАЯ ТЕХНИЧЕСКАЯ ПРОВЕРКА"
      echo
      echo "Когда использовать:"
      echo "- перед merge в main"
      echo "- перед выкладкой на рабочий сервер"
      echo "- после Stage/Codex изменений"
      echo "- после изменений summary/import/storage/backend"
      echo
      echo "Для чего нужен:"
      echo "- это техосмотр проекта перед слиянием и production deploy"
      echo "- проверить, что backend-тесты не сломаны"
      echo "- проверить синтаксис ключевых frontend-файлов"
      echo "- убедиться, что calc_engine.js не был случайно изменён"
      echo "- быстро увидеть состояние docker/nginx/api"
      echo
      echo "Что будет сделано:"
      echo "python -m unittest discover -s backend/tests"
      echo "node --check для ключевых JS-файлов, если node доступен"
      echo "git diff guard для web/calc_engine.js"
      echo "проверка отличий web/calc_engine.js относительно origin/main"
      echo "docker compose ps"
      echo "curl nginx / и /api/auth/me"
      echo
      echo "Важно: этот пункт НЕ делает deploy, НЕ restart и НЕ меняет данные."
      ;;
    *)
      echo "Нет такого сценария."
      return 1
      ;;
  esac
  print_line
}

select_branch() {
  echo
  print_line
  echo "ВЫБОР ТЕСТОВОЙ ВЕТКИ"
  print_line

  run git fetch origin --prune || return 1

  # FIX: после fetch Git иногда уже показывает [new branch],
  # но remote-refs не успевают попасть в git branch -r в этом же цикле.
  # Небольшая пауза убирает необходимость перезапускать меню второй раз.
  sleep 1

  mapfile -t branches < <(
    git branch -r \
      | sed 's#^[[:space:]]*origin/##' \
      | grep -v '^HEAD ' \
      | grep -v '^main$' \
      | sort
  )

  if [ "${#branches[@]}" -eq 0 ]; then
    echo "ОШИБКА: не найдено remote-веток origin/*"
    echo
    echo "ВАЖНО: сервер не видит локальные ветки Windows/Codex напрямую."
    echo "Сначала опубликуй ветку с Windows:"
    echo "  git push -u origin ИМЯ_ВЕТКИ"
    LAST_ERROR=1
    return 1
  fi

  echo
  echo "Показаны ВСЕ remote-ветки origin/*, кроме main."
  echo "Если нужной ветки нет — она не опубликована на GitHub."
  echo "Для локальной ветки Windows сначала выполни:"
  echo "  git push -u origin ИМЯ_ВЕТКИ"
  echo
  echo "0) Ввести имя ветки вручную"
  local i=1
  for b in "${branches[@]}"; do
    echo "$i) $b"
    i=$((i + 1))
  done

  echo
  read -rp "Выбери номер ветки или 0 для ручного ввода: " num

  if ! [[ "$num" =~ ^[0-9]+$ ]]; then
    echo "ОШИБКА: нужно ввести номер."
    LAST_ERROR=1
    return 1
  fi

  if [ "$num" -eq 0 ]; then
    echo
    read -rp "Введи имя ветки без origin/ (например codex/stage13-period-keys): " manual_branch
    manual_branch="$(echo "$manual_branch" | sed 's#^[[:space:]]*##;s#[[:space:]]*$##;s#^origin/##')"

    if [ -z "$manual_branch" ]; then
      echo "ОШИБКА: имя ветки пустое."
      LAST_ERROR=1
      return 1
    fi

    if ! git show-ref --verify --quiet "refs/remotes/origin/$manual_branch"; then
      echo "ОШИБКА: origin/$manual_branch не найдена на сервере."
      echo
      echo "Это значит, что ветка НЕ опубликована на GitHub."
      echo "На Windows/Codex/GitHub Desktop нужно сделать push:"
      echo "  git push -u origin $manual_branch"
      LAST_ERROR=1
      return 1
    fi

    SELECTED_BRANCH="$manual_branch"
    echo "Выбрана ветка вручную: $SELECTED_BRANCH"
    return 0
  fi

  if [ "$num" -lt 1 ] || [ "$num" -gt "${#branches[@]}" ]; then
    echo "ОШИБКА: такого номера нет."
    LAST_ERROR=1
    return 1
  fi

  SELECTED_BRANCH="${branches[$((num - 1))]}"
  echo "Выбрана ветка: $SELECTED_BRANCH"
}

show_logs() {
  echo
  print_line
  echo "ЛОГИ NGINX"
  print_line
  docker compose logs --tail=80 nginx || true

  echo
  print_line
  echo "ЛОГИ API"
  print_line
  docker compose logs --tail=120 api || true
}


node_check_file() {
  local f="$1"

  if [ ! -f "$f" ]; then
    echo "WARNING: файл не найден, пропускаю: $f"
    return 0
  fi

  if ! command -v node >/dev/null 2>&1; then
    echo "WARNING: node не найден, syntax check пропущен для: $f"
    return 0
  fi

  run node --check "$f"
}

calc_engine_stage_guard() {
  echo "Проверка 1: нет незакоммиченных изменений web/calc_engine.js"
  run git diff --exit-code -- web/calc_engine.js || return 1

  echo
  echo "Проверка 2: изменялся ли web/calc_engine.js относительно origin/main"
  if git rev-parse --verify origin/main >/dev/null 2>&1; then
    if ! git diff --quiet origin/main...HEAD -- web/calc_engine.js; then
      echo "ОШИБКА: web/calc_engine.js отличается от origin/main в текущей ветке."
      echo "Финансовое ядро нельзя менять без отдельного ТЗ."
      git diff --stat origin/main...HEAD -- web/calc_engine.js || true
      LAST_ERROR=1
      return 1
    fi
    echo "OK: web/calc_engine.js не менялся относительно origin/main"
  else
    echo "WARNING: origin/main не найден, выполнена только проверка локального diff."
  fi
}

full_stage_verification() {
  echo
  print_line
  echo "ФИНАЛЬНАЯ ТЕХНИЧЕСКАЯ ПРОВЕРКА"
  print_line
  echo "Назначение: проверка этапа перед merge и перед выкладкой на рабочий сервер."
  echo "Важно: этот сценарий НЕ делает deploy, НЕ restart и НЕ меняет данные."
  echo

  echo "=== 1) BACKEND UNIT TESTS ==="
  run docker compose exec api sh -lc "cd /app && python -m unittest discover -s tests" || return 1

  echo
  echo "=== 2) FRONTEND SYNTAX CHECKS ==="
  local js_files=(
    "web/data.js"
    "web/storage.js"
    "web/payment_table.js"
    "web/autoaccrual_engine.js"
    "web/spravka_sud.js"
  )

  local f
  for f in "${js_files[@]}"; do
    node_check_file "$f" || return 1
  done

  echo
  echo "=== 3) CALC ENGINE GUARD ==="
  echo "Проверка: web/calc_engine.js не должен быть изменён текущим этапом без отдельного ТЗ."
  calc_engine_stage_guard || return 1

  echo
  echo "=== 4) DOCKER STATUS ==="
  run docker compose ps || return 1

  echo
  echo "=== 5) NGINX CHECK ==="
  NGINX_STATUS=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1/ || true)
  echo "nginx / status: $NGINX_STATUS"
  if [ "$NGINX_STATUS" != "200" ] && [ "$NGINX_STATUS" != "302" ]; then
    echo "ОШИБКА: nginx / должен отвечать 200 или 302"
    LAST_ERROR=1
    return 1
  fi

  echo
  echo "=== 6) API AUTH CHECK ==="
  API_STATUS=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1/api/auth/me || true)
  echo "api /api/auth/me status: $API_STATUS"
  if [ "$API_STATUS" != "401" ]; then
    echo "ОШИБКА: API должен отвечать 401 на /api/auth/me для неавторизованного запроса"
    LAST_ERROR=1
    return 1
  fi

  echo
  echo "✅ Финальная техническая проверка пройдена."
}

run_case() {
  LAST_ERROR=0
  go_project || { show_final_status; check_result; return; }

  case "$1" in
    1)
      run git checkout main || true
      [ "$LAST_ERROR" -ne 0 ] && { show_final_status; check_result; return; }

      run git pull origin main || true
      [ "$LAST_ERROR" -ne 0 ] && { show_final_status; check_result; return; }

      run docker compose restart || true
      ;;
    2)
      echo
      read -rp "Для подтверждения напиши YES: " c
      if [ "$c" != "YES" ]; then
        echo "Отменено пользователем."
        LAST_ERROR=1
        show_final_status
        check_result
        return
      fi

      run git fetch origin || true
      [ "$LAST_ERROR" -ne 0 ] && { show_final_status; check_result; return; }

      run git checkout main || true
      [ "$LAST_ERROR" -ne 0 ] && { show_final_status; check_result; return; }

      run git reset --hard origin/main || true
      [ "$LAST_ERROR" -ne 0 ] && { show_final_status; check_result; return; }

      run docker compose restart || true
      ;;
    3)
      run git checkout main || true
      [ "$LAST_ERROR" -ne 0 ] && { show_final_status; check_result; return; }

      run git pull origin main || true
      [ "$LAST_ERROR" -ne 0 ] && { show_final_status; check_result; return; }

      run docker compose up -d --build || true
      ;;
    4)
      select_branch || { show_final_status; check_result; return; }

      run git checkout -B test-pr origin/"$SELECTED_BRANCH" || true
      [ "$LAST_ERROR" -ne 0 ] && { show_final_status; check_result; return; }

      run docker compose up -d --build || true
      ;;
    5)
      select_branch || { show_final_status; check_result; return; }

      run git checkout -B test-pr origin/"$SELECTED_BRANCH" || true
      [ "$LAST_ERROR" -ne 0 ] && { show_final_status; check_result; return; }

      run docker compose restart || true
      ;;
    6)
      run docker compose restart || true
      ;;
    7)
      ;;
    8)
      show_logs
      ;;
    9)
      echo
      print_line
      echo "БЕЗОПАСНОЕ ОБНОВЛЕНИЕ MAIN: BACKUP + CHECK + DEPLOY"
      print_line

      BACKUP_DIR="/root/jkh_backups"
      BACKUP_FILE="$BACKUP_DIR/backup_$(date +%F_%H-%M).sql"

      echo
      echo "=== 1) LOAD .ENV ==="
      load_env || { show_final_status; check_result; return; }
      echo "✅ .env загружен: $ENV_FILE"
      echo "База: $DB_NAME_EFFECTIVE"
      echo "Пользователь приложения: $DB_USER_EFFECTIVE"

      echo
      echo "=== 2) BACKUP MYSQL ==="
      run mkdir -p "$BACKUP_DIR" || true
      [ "$LAST_ERROR" -ne 0 ] && { show_final_status; check_result; return; }

      run mysql_root_dump "$BACKUP_FILE" || true
      [ "$LAST_ERROR" -ne 0 ] && { show_final_status; check_result; return; }

      if [ ! -s "$BACKUP_FILE" ]; then
        echo "ОШИБКА: backup не создан или файл пустой: $BACKUP_FILE"
        LAST_ERROR=1
        show_final_status
        check_result
        return
      fi

      echo "✅ Backup создан: $BACKUP_FILE"
      ls -lh "$BACKUP_FILE" || true

      echo
      echo "=== 3) CHECK MYSQL ==="
      run mysql_app_check || true
      [ "$LAST_ERROR" -ne 0 ] && { show_final_status; check_result; return; }

      echo
      echo "=== 4) CHECK API BEFORE DEPLOY ==="
      STATUS=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1/api/auth/me || true)
      echo "API status: $STATUS"
      if [ "$STATUS" != "401" ]; then
        echo "ОШИБКА: API перед деплоем должен отвечать 401 на /api/auth/me"
        LAST_ERROR=1
        show_final_status
        check_result
        return
      fi

      echo
      echo "=== 5) GIT MAIN UPDATE ==="
      run git checkout main || true
      [ "$LAST_ERROR" -ne 0 ] && { show_final_status; check_result; return; }

      run git pull origin main || true
      [ "$LAST_ERROR" -ne 0 ] && { show_final_status; check_result; return; }

      echo
      echo "=== 6) DOCKER BUILD + UP ==="
      run docker compose up -d --build || true
      [ "$LAST_ERROR" -ne 0 ] && { show_final_status; check_result; return; }

      echo
      echo "=== 7) FINAL MYSQL CHECK ==="
      run mysql_app_check || true
      [ "$LAST_ERROR" -ne 0 ] && { show_final_status; check_result; return; }

      echo
      echo "=== 8) FINAL API CHECK ==="
      STATUS=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1/api/auth/me || true)
      echo "API status: $STATUS"
      if [ "$STATUS" != "401" ]; then
        echo "ОШИБКА: API после деплоя должен отвечать 401 на /api/auth/me"
        LAST_ERROR=1
      fi
      ;;
    10)
      full_stage_verification || true
      ;;
    *)
      echo "Нет такого пункта."
      LAST_ERROR=1
      ;;
  esac

  show_final_status
  check_result
}

menu() {
  clear
  echo "============================================================"
  echo "JKH SERVER DEPLOY MENU v4.2"
  echo "============================================================"
  echo
  echo "1) Обычное обновление main"
  echo "2) Жёсткий возврат на чистый main"
  echo "3) Main с docker build"
  echo "4) Тестовая ветка с build"
  echo "5) Тестовая ветка быстро, без build"
  echo "6) Только restart docker"
  echo "7) Только проверки"
  echo "8) Показать логи nginx/api"
  echo "9) Безопасное обновление main (backup + check + deploy из .env)"
  echo "10) Финальная техническая проверка перед merge/deploy"
  echo "0) Выход"
  echo
}

main() {
  while true; do
    menu
    read -rp "Выбери сценарий: " choice

    [ "$choice" = "0" ] && exit 0

    explain "$choice" || { pause; continue; }

    echo
    read -rp "Запустить этот сценарий? Напиши y: " confirm
    if [ "$confirm" != "y" ]; then
      echo "Отменено."
      pause
      continue
    fi

    run_case "$choice"
    pause
  done
}

main "$@"
