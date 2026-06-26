#!/usr/bin/env bash
# ============================================================
# JKH SERVER DEPLOY MENU v5 (LAB / PROD, SUCCESS / ERROR)
# ============================================================

set -u

ENVIRONMENT=""
PROJECT_DIR=""
SITE_CHECK=""
API_CHECK=""
ENV_FILE=""
MYSQL_CONTAINER=""
BACKUP_DIR="/root/jkh_backups"
LAST_ERROR=0

print_line() {
  echo "============================================================"
}

success() {
  echo
  print_line
  echo "SUCCESS: операция завершена"
  print_line
}

fail() {
  echo
  print_line
  echo "ERROR: операция НЕ завершена"
  echo "Смотри сообщение об ошибке выше."
  print_line
}

run() {
  echo
  echo ">>> $*"
  "$@"
  local code=$?
  if [ "$code" -ne 0 ]; then
    echo "ОШИБКА команды: $*"
    echo "Код ошибки: $code"
    LAST_ERROR=$code
    return "$code"
  fi
  return 0
}

pause() {
  echo
  read -rp "Нажми Enter для возврата в меню..."
}

select_environment() {
  while true; do
    clear
    print_line
    echo "JKH SERVER DEPLOY MENU v5"
    print_line
    echo "1) LAB  (/root/jkh-lab, http://127.0.0.1:8080)"
    echo "2) PROD (/root/jkh,     http://127.0.0.1/)"
    echo "0) Выход"
    echo
    read -rp "Выбери среду: " choice

    case "$choice" in
      1)
        ENVIRONMENT="LAB"
        PROJECT_DIR="/root/jkh-lab"
        SITE_CHECK="http://127.0.0.1:8080"
        MYSQL_CONTAINER="jkh_lab_mysql"
        ;;
      2)
        ENVIRONMENT="PROD"
        PROJECT_DIR="/root/jkh"
        SITE_CHECK="http://127.0.0.1/"
        MYSQL_CONTAINER="jkh_mysql"
        ;;
      0)
        exit 0
        ;;
      *)
        echo "Нет такой среды."
        pause
        continue
        ;;
    esac

    ENV_FILE="$PROJECT_DIR/.env"
    API_CHECK="${SITE_CHECK%/}/api/auth/me"

    if [ ! -d "$PROJECT_DIR/.git" ]; then
      echo "ОШИБКА: $PROJECT_DIR не является git-репозиторием."
      pause
      continue
    fi

    cd "$PROJECT_DIR" || {
      echo "ОШИБКА: не удалось перейти в $PROJECT_DIR"
      pause
      continue
    }
    return 0
  done
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
  # shellcheck disable=SC1090
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
  docker exec -e MYSQL_PWD="$MYSQL_ROOT_PASSWORD" "$MYSQL_CONTAINER" \
    mysqldump -u root --single-transaction --routines --triggers \
    "$DB_NAME_EFFECTIVE" > "$backup_file"
}

mysql_app_check() {
  docker exec -e MYSQL_PWD="$DB_PASSWORD_EFFECTIVE" "$MYSQL_CONTAINER" \
    mysql -u "$DB_USER_EFFECTIVE" "$DB_NAME_EFFECTIVE" -e "SELECT 1;"
}

require_prod_confirmation() {
  local action="$1"
  local answer

  [ "$ENVIRONMENT" = "PROD" ] || return 0

  echo
  print_line
  echo "ВНИМАНИЕ: ОПАСНОЕ ДЕЙСТВИЕ В PROD"
  echo "$action"
  print_line
  read -rp "До любых изменений введи YES_PROD: " answer
  if [ "$answer" != "YES_PROD" ]; then
    echo "Операция отменена. Git и Docker не изменялись."
    LAST_ERROR=1
    return 1
  fi
}

confirm_worktree_changes() {
  local changes answer

  changes="$(git status --porcelain)"
  if [ -z "$changes" ]; then
    return 0
  fi

  echo
  echo "ВНИМАНИЕ: найдены modified/untracked файлы:"
  echo "$changes"
  echo "Автоматические git reset --hard и git clean не выполняются."
  read -rp "Продолжить без удаления локальных файлов? Напиши y: " answer
  if [ "$answer" != "y" ]; then
    echo "Операция отменена."
    LAST_ERROR=1
    return 1
  fi
}

wait_for_containers() {
  echo
  echo "Ожидание запуска контейнеров..."
  sleep 3
}

check_http_status() {
  local label="$1"
  local url="$2"
  shift 2
  local status expected

  status="$(curl -sS -o /dev/null -w "%{http_code}" "$url")"
  local curl_code=$?
  echo "$label: $url -> HTTP $status"
  if [ "$curl_code" -ne 0 ]; then
    echo "ОШИБКА: curl завершился с кодом $curl_code"
    LAST_ERROR=$curl_code
    return "$curl_code"
  fi

  for expected in "$@"; do
    if [ "$status" = "$expected" ]; then
      return 0
    fi
  done

  echo "ОШИБКА: неожиданный HTTP-код $status"
  LAST_ERROR=1
  return 1
}

check_site() {
  check_http_status "Сайт" "$SITE_CHECK" 200 302
}

check_api() {
  check_http_status "API auth" "$API_CHECK" 401
}

create_mysql_backup() {
  local backup_file

  load_env || return 1
  backup_file="$BACKUP_DIR/${ENVIRONMENT,,}_backup_$(date +%F_%H-%M-%S).sql"

  run mkdir -p "$BACKUP_DIR" || return 1
  echo "Создаётся backup: $backup_file"
  run mysql_root_dump "$backup_file" || return 1

  if [ ! -s "$backup_file" ]; then
    echo "ОШИБКА: backup не создан или пустой: $backup_file"
    LAST_ERROR=1
    return 1
  fi

  run ls -lh "$backup_file" || return 1
}

prepare_deploy() {
  local action="$1"

  require_prod_confirmation "$action" || return 1
  confirm_worktree_changes || return 1

  if [ "$ENVIRONMENT" = "PROD" ]; then
    create_mysql_backup || return 1
    run mysql_app_check || return 1
    check_api || return 1
  fi
}

show_final_status() {
  echo
  print_line
  echo "ИТОГОВАЯ ПРОВЕРКА | $ENVIRONMENT"
  print_line

  echo
  echo "Папка:"
  pwd

  echo
  echo "Текущая ветка:"
  run git branch --show-current || true

  echo
  echo "Git status:"
  run git status -sb || true

  echo
  echo "Последние 3 коммита:"
  run git log --oneline -n 3 || true

  echo
  echo "Docker containers:"
  run docker compose ps || true

  wait_for_containers

  echo
  echo "Проверка сайта:"
  check_site || true

  echo
  echo "Проверка API:"
  check_api || true
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
      echo "СЦЕНАРИЙ 1: ОБЫЧНОЕ ОБНОВЛЕНИЕ MAIN БЕЗ BUILD"
      echo "git checkout main -> git pull --ff-only -> docker compose restart"
      ;;
    2)
      echo "СЦЕНАРИЙ 2: ЖЁСТКИЙ ВОЗВРАТ НА ЧИСТЫЙ MAIN"
      echo "Отдельный аварийный сценарий: git reset --hard origin/main."
      echo "Локальные tracked-изменения будут удалены; git clean не выполняется."
      ;;
    3)
      echo "СЦЕНАРИЙ 3: MAIN С ПЕРЕСБОРКОЙ"
      echo "git checkout main -> git pull --ff-only -> docker compose up -d --build"
      ;;
    4)
      echo "СЦЕНАРИЙ 4: ТЕСТОВАЯ ВЕТКА С BUILD"
      echo "Выбор origin/* -> локальная test-pr -> docker compose up -d --build"
      ;;
    5)
      echo "СЦЕНАРИЙ 5: ТЕСТОВАЯ ВЕТКА БЕЗ BUILD"
      echo "Выбор origin/* -> локальная test-pr -> docker compose restart"
      ;;
    6)
      echo "СЦЕНАРИЙ 6: ТОЛЬКО RESTART"
      echo "Код и Git не меняются. Выполняется docker compose restart."
      ;;
    7)
      echo "СЦЕНАРИЙ 7: БАЗОВЫЕ ПРОВЕРКИ"
      echo "Compose config, MySQL, контейнеры, сайт и /api/auth/me."
      ;;
    8)
      echo "СЦЕНАРИЙ 8: ЛОГИ NGINX/API"
      echo "Показывает последние строки логов nginx и api."
      ;;
    9)
      echo "СЦЕНАРИЙ 9: БЕЗОПАСНОЕ ОБНОВЛЕНИЕ MAIN"
      echo "Backup + MySQL/API preflight + pull main + build + итоговые проверки."
      ;;
    10)
      echo "СЦЕНАРИЙ 10: ФИНАЛЬНАЯ ТЕХНИЧЕСКАЯ ПРОВЕРКА"
      echo "Backend tests, node --check, calc_engine guard, Docker, сайт и API."
      echo "Deploy, restart и изменение данных не выполняются."
      ;;
    11)
      echo "СЦЕНАРИЙ 11: ПРИМЕНИТЬ ОДИН КОММИТ CHERRY-PICK"
      echo "fetch -> git show --stat -> подтверждение -> cherry-pick -> build."
      ;;
    12)
      echo "СЦЕНАРИЙ 12: СМЕНИТЬ СРЕДУ"
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
    LAST_ERROR=1
    return 1
  fi

  echo "Показаны все remote-ветки origin/*, кроме main."
  echo "0) Ввести имя ветки вручную"
  local i=1
  local b
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
    read -rp "Введи имя ветки без origin/: " manual_branch
    manual_branch="$(echo "$manual_branch" | sed 's#^[[:space:]]*##;s#[[:space:]]*$##;s#^origin/##')"
    if [ -z "$manual_branch" ]; then
      echo "ОШИБКА: имя ветки пустое."
      LAST_ERROR=1
      return 1
    fi
    if ! git show-ref --verify --quiet "refs/remotes/origin/$manual_branch"; then
      echo "ОШИБКА: origin/$manual_branch не найдена."
      LAST_ERROR=1
      return 1
    fi
    SELECTED_BRANCH="$manual_branch"
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
  run docker compose logs --tail=80 nginx || true

  echo
  print_line
  echo "ЛОГИ API"
  print_line
  run docker compose logs --tail=120 api || true
}

node_check_file() {
  local file="$1"

  if [ ! -f "$file" ]; then
    echo "WARNING: файл не найден, пропускаю: $file"
    return 0
  fi
  if ! command -v node >/dev/null 2>&1; then
    echo "WARNING: node не найден, syntax check пропущен: $file"
    return 0
  fi
  run node --check "$file"
}

calc_engine_stage_guard() {
  echo "Проверка локальных изменений web/calc_engine.js"
  run git diff --exit-code -- web/calc_engine.js || return 1

  echo "Проверка web/calc_engine.js относительно origin/main"
  if git rev-parse --verify origin/main >/dev/null 2>&1; then
    if ! git diff --quiet origin/main...HEAD -- web/calc_engine.js; then
      echo "ОШИБКА: web/calc_engine.js отличается от origin/main."
      git diff --stat origin/main...HEAD -- web/calc_engine.js || true
      LAST_ERROR=1
      return 1
    fi
  else
    echo "WARNING: origin/main не найден."
  fi
}

full_stage_verification() {
  echo
  print_line
  echo "ФИНАЛЬНАЯ ТЕХНИЧЕСКАЯ ПРОВЕРКА"
  print_line

  run docker compose exec api sh -lc \
    "cd /app && python -m unittest discover -s tests" || return 1

  local js_files=(
    "web/data.js"
    "web/storage.js"
    "web/payment_table.js"
    "web/autoaccrual_engine.js"
    "web/spravka_sud.js"
  )
  local file
  for file in "${js_files[@]}"; do
    node_check_file "$file" || return 1
  done

  calc_engine_stage_guard || return 1
  run docker compose ps || return 1
  check_site || return 1
  check_api || return 1
}

run_basic_checks() {
  run docker compose config --quiet || return 1
  load_env || return 1
  run mysql_app_check || return 1
  run docker compose ps || return 1
  check_site || return 1
  check_api || return 1
}

deploy_main_no_build() {
  prepare_deploy "Обновление main без build" || return 1
  run git checkout main || return 1
  run git pull --ff-only origin main || return 1
  run docker compose restart || return 1
}

hard_reset_main() {
  local answer

  require_prod_confirmation "Жёсткий reset main" || return 1
  echo
  read -rp "Для удаления tracked-изменений введи RESET_MAIN: " answer
  if [ "$answer" != "RESET_MAIN" ]; then
    echo "Операция отменена до изменений Git и Docker."
    LAST_ERROR=1
    return 1
  fi
  create_mysql_backup || return 1
  run git fetch origin || return 1
  run git checkout main || return 1
  run git reset --hard origin/main || return 1
  run docker compose restart || return 1
}

deploy_main_with_build() {
  prepare_deploy "Обновление main с docker build" || return 1
  run git checkout main || return 1
  run git pull --ff-only origin main || return 1
  run docker compose up -d --build || return 1
}

deploy_test_branch() {
  local with_build="$1"
  local description="Тестовая ветка без build"
  [ "$with_build" = "yes" ] && description="Тестовая ветка с build"

  prepare_deploy "$description" || return 1
  select_branch || return 1
  run git checkout -B test-pr "origin/$SELECTED_BRANCH" || return 1

  if [ "$with_build" = "yes" ]; then
    run docker compose up -d --build || return 1
  else
    run docker compose restart || return 1
  fi
}

restart_services() {
  require_prod_confirmation "Restart контейнеров PROD" || return 1
  run docker compose restart
}

safe_main_deploy() {
  prepare_deploy "Безопасное обновление main: backup + build" || return 1
  if [ "$ENVIRONMENT" = "LAB" ]; then
    load_env || return 1
    run mysql_app_check || return 1
    check_api || return 1
  fi
  run git checkout main || return 1
  run git pull --ff-only origin main || return 1
  run docker compose up -d --build || return 1
  wait_for_containers
  run mysql_app_check || return 1
  check_api || return 1
}

cherry_pick_commit() {
  local hash answer

  require_prod_confirmation "Cherry-pick одного коммита с docker build" || return 1
  confirm_worktree_changes || return 1
  if [ "$ENVIRONMENT" = "PROD" ]; then
    create_mysql_backup || return 1
    run mysql_app_check || return 1
    check_api || return 1
  fi

  run git fetch origin || return 1
  read -rp "Хеш коммита: " hash
  if [ -z "$hash" ]; then
    echo "ОШИБКА: хеш не задан."
    LAST_ERROR=1
    return 1
  fi
  run git show --stat "$hash" || return 1
  read -rp "Применить этот коммит? Напиши y: " answer
  if [ "$answer" != "y" ]; then
    echo "Операция отменена до cherry-pick и Docker build."
    LAST_ERROR=1
    return 1
  fi

  run git cherry-pick "$hash" || {
    echo "Для отмены конфликта: git cherry-pick --abort"
    return 1
  }
  run docker compose up -d --build || return 1
}

run_case() {
  LAST_ERROR=0
  go_project || {
    show_final_status
    check_result
    return
  }

  case "$1" in
    1) deploy_main_no_build || true ;;
    2) hard_reset_main || true ;;
    3) deploy_main_with_build || true ;;
    4) deploy_test_branch "yes" || true ;;
    5) deploy_test_branch "no" || true ;;
    6) restart_services || true ;;
    7) run_basic_checks || true ;;
    8) show_logs ;;
    9) safe_main_deploy || true ;;
    10) full_stage_verification || true ;;
    11) cherry_pick_commit || true ;;
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
  print_line
  echo "JKH SERVER DEPLOY MENU v5 | $ENVIRONMENT"
  echo "$PROJECT_DIR | $SITE_CHECK"
  print_line
  echo "1) Обычное обновление main без build"
  echo "2) Жёсткий возврат на чистый main"
  echo "3) Main с docker build"
  echo "4) Тестовая ветка с build"
  echo "5) Тестовая ветка без build через restart"
  echo "6) Только restart docker"
  echo "7) Базовые проверки"
  echo "8) Показать логи nginx/api"
  echo "9) Безопасное обновление main"
  echo "10) Финальная техническая проверка"
  echo "11) Применить один коммит cherry-pick"
  echo "12) Сменить LAB/PROD"
  echo "0) Выход"
  echo
}

main() {
  select_environment

  while true; do
    menu
    read -rp "Выбери сценарий: " choice

    [ "$choice" = "0" ] && exit 0
    if [ "$choice" = "12" ]; then
      select_environment
      continue
    fi

    explain "$choice" || {
      pause
      continue
    }

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
