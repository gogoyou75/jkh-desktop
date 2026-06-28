#!/usr/bin/env bash
# ============================================================
# JKH SERVER MENU v5.3 (LAB / PROD, protected operations)
# ============================================================

set -u

VERSION="v5.3"

ENVIRONMENT=""
PROJECT_DIR=""
SITE_CHECK=""
API_CHECK=""
ENV_FILE=""
MYSQL_CONTAINER=""
BACKUP_DIR="/root/jkh_backups"
MANUAL_BACKUP_DIR="/root/backups"
LOCK_FILE="/tmp/jkh_server_menu_v5_3.lock"
SELECTED_BRANCH=""
SELECTED_COMMIT=""
LAST_ERROR=0
LAST_BLOCKED=0
BLOCKED_MESSAGE=""
LAST_BLOCK_REASONS=()
LOCK_HELD=0

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

blocked() {
  echo
  print_line
  if [ "${#LAST_BLOCK_REASONS[@]}" -gt 0 ]; then
    echo "BLOCKED:"
    print_block_reasons
    print_preflight_next_steps_blocked
  elif [ -n "$BLOCKED_MESSAGE" ]; then
    echo "$BLOCKED_MESSAGE"
  else
    echo "BLOCKED: сценарий запрещён для этой среды"
  fi
  print_line
}

block_operation() {
  BLOCKED_MESSAGE="$1"
  LAST_ERROR=1
  LAST_BLOCKED=1
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

cleanup_lock() {
  if [ "$LOCK_HELD" -eq 1 ]; then
    rm -f "$LOCK_FILE"
    LOCK_HELD=0
  fi
}

trap cleanup_lock EXIT INT TERM

acquire_lock() {
  if [ -f "$LOCK_FILE" ]; then
    echo "ОШИБКА: найден lock-файл: $LOCK_FILE"
    echo "Это защита от одновременного запуска двух операций."
    echo
    echo "Что делать:"
    echo "1) Проверь, не открыт ли этот скрипт во втором окне."
    echo "2) Если точно ничего не выполняется, удали lock-файл вручную:"
    echo "   rm -f $LOCK_FILE"
    LAST_ERROR=1
    return 1
  fi

  printf '%s\n' "pid=$$ env=$ENVIRONMENT dir=$PROJECT_DIR date=$(date '+%F %T')" > "$LOCK_FILE"
  LOCK_HELD=1
}

release_lock() {
  cleanup_lock
}

set_environment_vars() {
  case "$1" in
    LAB)
      ENVIRONMENT="LAB"
      PROJECT_DIR="/root/jkh-lab"
      SITE_CHECK="http://127.0.0.1:8080"
      MYSQL_CONTAINER="jkh_lab_mysql"
      ;;
    PROD)
      ENVIRONMENT="PROD"
      PROJECT_DIR="/root/jkh"
      SITE_CHECK="http://127.0.0.1/"
      MYSQL_CONTAINER="jkh_mysql"
      ;;
    *)
      echo "ОШИБКА: неизвестная среда: $1"
      LAST_ERROR=1
      return 1
      ;;
  esac

  ENV_FILE="$PROJECT_DIR/.env"
  API_CHECK="${SITE_CHECK%/}/api/auth/me"
}

select_environment() {
  while true; do
    clear
    print_line
    echo "ПАПАЖКХ SERVER MENU $VERSION"
    print_line
    echo "Выбор среды означает: какую папку, Docker и сайт будет трогать меню."
    echo
    echo "1) LAB  (/root/jkh-lab, http://127.0.0.1:8080)"
    echo "   Тестовая среда. Используется для проверки веток и безопасных проб."
    echo
    echo "2) PROD (/root/jkh,     http://127.0.0.1/)"
    echo "   Рабочая среда. Опасные действия требуют YES_PROD и backup MySQL."
    echo
    echo "0) Выход"
    echo
    read -rp "Выбери среду: " choice

    case "$choice" in
      1) set_environment_vars "LAB" ;;
      2) set_environment_vars "PROD" ;;
      0) exit 0 ;;
      *)
        echo "Нет такой среды."
        pause
        continue
        ;;
    esac

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

show_context() {
  print_line
  echo "ТЕКУЩИЙ КОНТЕКСТ"
  print_line
  echo "Среда:        $ENVIRONMENT"
  echo "Папка:        $PROJECT_DIR"
  echo "Сайт:         $SITE_CHECK"
  echo "API:          $API_CHECK"
  echo "MySQL:        $MYSQL_CONTAINER"
  echo "Файл .env:    $ENV_FILE"
  echo "Lock-файл:    $LOCK_FILE"
  if [ "$ENVIRONMENT" = "PROD" ]; then
    echo "PROD:         ДА. Опасные действия требуют YES_PROD."
  else
    echo "PROD:         НЕТ. Это LAB."
  fi
  print_line
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

  echo "OK: .env найден и содержит нужные MySQL-переменные."
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

check_http_status() {
  local label="$1"
  local url="$2"
  shift 2
  local status expected curl_code

  status="$(curl -sS -o /dev/null -w "%{http_code}" "$url")"
  curl_code=$?
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

health_check() {
  echo
  print_line
  echo "HEALTH CHECK | $ENVIRONMENT"
  print_line
  echo "Проверяем, что сайт и API отвечают ожидаемо."
  check_site || return 1
  check_api || return 1
}

require_prod_confirmation() {
  local action="$1"
  local answer

  [ "$ENVIRONMENT" = "PROD" ] || return 0

  echo
  print_line
  echo "ВНИМАНИЕ: ОПАСНОЕ ДЕЙСТВИЕ В PROD"
  echo "$action"
  echo
  echo "Это рабочая среда: $PROJECT_DIR"
  echo "Сайт: $SITE_CHECK"
  print_line
  read -rp "До любых изменений введи YES_PROD: " answer
  if [ "$answer" != "YES_PROD" ]; then
    echo "Операция отменена. Git, Docker и база не изменялись."
    LAST_ERROR=1
    return 1
  fi
}

confirm_worktree_changes() {
  local changes answer

  echo
  echo "Проверка git status перед изменениями..."
  changes="$(git status --porcelain)"
  if [ -z "$changes" ]; then
    echo "OK: незакоммиченных изменений нет."
    return 0
  fi

  echo
  echo "ВНИМАНИЕ: найдены modified/untracked файлы:"
  echo "$changes"
  echo
  echo "Меню НЕ выполняет очистку untracked-файлов и НЕ удаляет локальные файлы."
  echo "Если продолжить, Git может отказаться переключать ветку или pull."
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

create_mysql_backup() {
  local backup_file

  load_env || return 1
  backup_file="$BACKUP_DIR/${ENVIRONMENT,,}_backup_$(date +%F_%H-%M-%S).sql"

  run mkdir -p "$BACKUP_DIR" || return 1
  echo "Создаётся backup MySQL: $backup_file"
  run mysql_root_dump "$backup_file" || return 1

  if [ ! -s "$backup_file" ]; then
    echo "ОШИБКА: backup не создан или пустой: $backup_file"
    LAST_ERROR=1
    return 1
  fi

  run ls -lh "$backup_file" || return 1
}

backup_current_environment() {
  local backup_file backup_db git_status answer

  require_prod_confirmation "Backup текущей PROD среды" || return 1
  environment_guard || return 1
  load_env || return 1

  case "$ENVIRONMENT" in
    LAB) backup_db="jkh_lab" ;;
    PROD) backup_db="jkh" ;;
    *)
      echo "ОШИБКА: неизвестная среда для backup: $ENVIRONMENT"
      LAST_ERROR=1
      return 1
      ;;
  esac

  backup_file="$MANUAL_BACKUP_DIR/${ENVIRONMENT,,}_backup_$(date +%F_%H-%M-%S).sql"
  git_status="$(git status --porcelain)"

  echo
  print_line
  echo "BACKUP ТЕКУЩЕЙ СРЕДЫ | $ENVIRONMENT"
  print_line
  echo "Среда:           $ENVIRONMENT"
  echo "Папка:           $PROJECT_DIR"
  echo "Текущая ветка:   $(git branch --show-current 2>/dev/null || echo unknown)"
  echo "HEAD commit:     $(git log --oneline -1 2>/dev/null || echo unknown)"
  echo "Git status:"
  git status -sb || true
  echo "MySQL container: $MYSQL_CONTAINER"
  echo "DB_NAME:         $backup_db"
  echo "Backup file:     $backup_file"
  echo
  echo "Backup сохраняет только MySQL-базу текущей среды. Ветка показана только для понимания, какой код сейчас рядом с этой базой. Ветку для backup выбирать не нужно."
  echo
  echo "Restore НЕ выполняется."
  echo "Docker down НЕ выполняется."
  echo "Git НЕ меняется."
  print_line

  if [ -n "$git_status" ]; then
    if [ "$ENVIRONMENT" = "PROD" ]; then
      echo "ВНИМАНИЕ: PROD git status не чистый."
      read -rp "Для backup PROD при dirty git status введи YES_PROD_DIRTY_BACKUP: " answer
      if [ "$answer" != "YES_PROD_DIRTY_BACKUP" ]; then
        block_operation "BLOCKED: PROD backup при dirty git status требует YES_PROD_DIRTY_BACKUP"
        return 1
      fi
    else
      echo "WARNING: LAB git status не чистый. Backup базы можно продолжить, Git не меняется."
      read -rp "Продолжить LAB backup при dirty git status? Напиши y: " answer
      if [ "$answer" != "y" ]; then
        echo "Backup отменён до mysqldump."
        LAST_ERROR=1
        return 1
      fi
    fi
  fi

  run mkdir -p "$MANUAL_BACKUP_DIR" || return 1
  echo "Создаётся backup MySQL: $backup_file"
  docker exec -e MYSQL_PWD="$MYSQL_ROOT_PASSWORD" "$MYSQL_CONTAINER" \
    mysqldump -u root --single-transaction --routines --triggers \
    "$backup_db" > "$backup_file"
  local dump_code=$?
  if [ "$dump_code" -ne 0 ]; then
    echo "ОШИБКА: mysqldump завершился с кодом $dump_code"
    LAST_ERROR=$dump_code
    return "$dump_code"
  fi

  if [ ! -s "$backup_file" ]; then
    echo "ОШИБКА: backup не создан или пустой: $backup_file"
    LAST_ERROR=1
    return 1
  fi

  run ls -lh "$backup_file" || return 1
}

require_main_scenario_prod() {
  if [ "$ENVIRONMENT" = "PROD" ]; then
    return 0
  fi

  echo "Main-сценарии в LAB запрещены. Используй пункт 4/5 для тестовой ветки."
  block_operation "BLOCKED: сценарий запрещён для этой среды"
  return 1
}

prod_main_branch_guard() {
  local current_branch head_commit origin_main_commit

  [ "$ENVIRONMENT" = "PROD" ] || return 0

  current_branch="$(git branch --show-current 2>/dev/null || true)"
  if [ "$current_branch" != "main" ]; then
    echo "ОШИБКА: PROD main-сценарий должен выполняться только на ветке main."
    echo "Текущая ветка: ${current_branch:-unknown}"
    LAST_ERROR=1
    return 1
  fi

  if ! git rev-parse --verify --quiet origin/main >/dev/null; then
    echo "ОШИБКА: origin/main не найден. Branch guard не пройден."
    LAST_ERROR=1
    return 1
  fi

  head_commit="$(git rev-parse HEAD)"
  origin_main_commit="$(git rev-parse origin/main)"
  if [ "$head_commit" != "$origin_main_commit" ]; then
    echo "ОШИБКА: PROD main-сценарий должен быть на origin/main."
    echo "HEAD:        $head_commit"
    echo "origin/main: $origin_main_commit"
    LAST_ERROR=1
    return 1
  fi
}

prepare_deploy() {
  local action="$1"
  local needs_prod_backup="$2"

  require_prod_confirmation "$action" || return 1
  confirm_worktree_changes || return 1

  if [ "$ENVIRONMENT" = "PROD" ] && [ "$needs_prod_backup" = "yes" ]; then
    create_mysql_backup || return 1
    run mysql_app_check || return 1
    check_api || return 1
  fi
}

infra_lock_hint() {
  echo
  echo "Infra-файлы ЦУП не восстанавливает автоматически из INFRA_LOCK."
  case "$ENVIRONMENT" in
    PROD)
      echo "Ручное восстановление PROD из lock-копии:"
      echo "  ls -td /root/INFRA_LOCK_*/PROD | head -1"
      echo "  cp /root/INFRA_LOCK_YYYYMMDD_HHMMSS/PROD/.env /root/jkh/.env"
      echo "  cp /root/INFRA_LOCK_YYYYMMDD_HHMMSS/PROD/docker-compose.yml /root/jkh/docker-compose.yml"
      echo "  cp /root/INFRA_LOCK_YYYYMMDD_HHMMSS/PROD/default.conf /root/jkh/nginx/default.conf"
      ;;
    LAB)
      echo "Ручное восстановление LAB из lock-копии:"
      echo "  ls -td /root/INFRA_LOCK_*/LAB | head -1"
      echo "  cp /root/INFRA_LOCK_YYYYMMDD_HHMMSS/LAB/.env /root/jkh-lab/.env"
      echo "  cp /root/INFRA_LOCK_YYYYMMDD_HHMMSS/LAB/docker-compose.yml /root/jkh-lab/docker-compose.yml"
      echo "  cp /root/INFRA_LOCK_YYYYMMDD_HHMMSS/LAB/default.conf /root/jkh-lab/nginx/default.conf"
      ;;
    *)
      echo "Ручное восстановление из lock-копии выбранной среды:"
      echo "  ls -td /root/INFRA_LOCK_*/PROD | head -1"
      echo "  ls -td /root/INFRA_LOCK_*/LAB | head -1"
      ;;
  esac
  echo "После восстановления снова запусти проверку."
}

read_env_key() {
  local key="$1"
  local value

  value="$(grep -E "^[[:space:]]*${key}=" "$ENV_FILE" | tail -n 1 | cut -d= -f2- || true)"
  value="${value%%#*}"
  value="${value%\"}"
  value="${value#\"}"
  value="${value%\'}"
  value="${value#\'}"
  printf '%s' "$value"
}

infra_sha256sum() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum .env docker-compose.yml nginx/default.conf
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 .env docker-compose.yml nginx/default.conf
  else
    echo "ОШИБКА: sha256sum/shasum не найден."
    LAST_ERROR=1
    return 1
  fi
}

infra_backup_before_git() {
  local backup_dir="$1"

  mkdir -p "$backup_dir" || {
    echo "ОШИБКА: не удалось создать temp backup dir для infra-файлов."
    LAST_ERROR=1
    return 1
  }

  cp -p .env "$backup_dir/.env" || return 1
  cp -p docker-compose.yml "$backup_dir/docker-compose.yml" || return 1
  cp -p nginx/default.conf "$backup_dir/default.conf" || return 1
}

infra_snapshot_before_git() {
  local snapshot_file="$1"
  local backup_dir

  infra_files_guard || return 1
  backup_dir="$(mktemp -d)" || {
    echo "ОШИБКА: не удалось создать temp backup dir для infra-файлов."
    LAST_ERROR=1
    return 1
  }

  infra_backup_before_git "$backup_dir" || {
    rm -rf "$backup_dir"
    LAST_ERROR=1
    return 1
  }

  {
    echo "BACKUP_DIR=$backup_dir"
    infra_sha256sum
  } > "$snapshot_file" || {
    rm -rf "$backup_dir"
    echo "ОШИБКА: не удалось сохранить backup и sha256sum infra-файлов перед git-операцией."
    LAST_ERROR=1
    return 1
  }
}

infra_check_after_git() {
  local snapshot_file="$1"
  local current_file backup_dir

  current_file="$(mktemp)" || {
    echo "ОШИБКА: не удалось создать временный файл для проверки infra sha256sum."
    LAST_ERROR=1
    return 1
  }

  if ! infra_sha256sum > "$current_file"; then
    rm -f "$current_file"
    block_operation "BLOCKED: после git-операции невозможно проверить infra-файлы"
    infra_lock_hint
    return 1
  fi

  if ! cmp -s <(tail -n +2 "$snapshot_file") "$current_file"; then
    echo "BLOCKED: git-операция изменила infra-файлы выбранной среды."
    echo
    echo "Было до git:"
    tail -n +2 "$snapshot_file" || true
    echo
    echo "Стало после git:"
    cat "$current_file" || true
    backup_dir="$(grep '^BACKUP_DIR=' "$snapshot_file" | tail -n 1 | cut -d= -f2-)"

    if [ -n "$backup_dir" ] && [ -d "$backup_dir" ]; then
      cp -p "$backup_dir/.env" .env || {
        rm -f "$current_file"
        rm -rf "$backup_dir"
        block_operation "BLOCKED: не удалось восстановить .env из локального backup"
        infra_lock_hint
        return 1
      }
      cp -p "$backup_dir/docker-compose.yml" docker-compose.yml || {
        rm -f "$current_file"
        rm -rf "$backup_dir"
        block_operation "BLOCKED: не удалось восстановить docker-compose.yml из локального backup"
        infra_lock_hint
        return 1
      }
      cp -p "$backup_dir/default.conf" nginx/default.conf || {
        rm -f "$current_file"
        rm -rf "$backup_dir"
        block_operation "BLOCKED: не удалось восстановить nginx/default.conf из локального backup"
        infra_lock_hint
        return 1
      }

      if infra_sha256sum > "$current_file" && cmp -s <(tail -n +2 "$snapshot_file") "$current_file"; then
        echo "OK: infra-файлы восстановлены в состояние до git-операции"
        rm -f "$current_file"
        rm -rf "$backup_dir"
        block_operation "BLOCKED: infra-файлы были изменены и восстановлены из локального backup"
        return 1
      fi
    fi

    rm -f "$current_file"
    [ -n "$backup_dir" ] && rm -rf "$backup_dir"
    block_operation "BLOCKED: infra-файлы изменились после git-операции"
    infra_lock_hint
    return 1
  fi

  rm -f "$current_file"
  backup_dir="$(grep '^BACKUP_DIR=' "$snapshot_file" | tail -n 1 | cut -d= -f2-)"
  [ -n "$backup_dir" ] && rm -rf "$backup_dir"
  echo "OK: infra-файлы не изменились после git-операции."
}

run_git_preserving_infra() {
  local snapshot_file="$1"
  local code
  shift

  echo
  echo ">>> $*"
  "$@"
  code=$?
  if [ "$code" -ne 0 ]; then
    echo "ОШИБКА команды: $*"
    echo "Код ошибки: $code"
  fi

  infra_check_after_git "$snapshot_file" || return 1

  if [ "$code" -ne 0 ]; then
    LAST_ERROR=$code
    return "$code"
  fi

  return 0
}

infra_files_guard() {
  local config_file env_type db_name pattern
  local required_config_patterns=()
  local forbidden_config_patterns=()

  for pattern in ".env" "docker-compose.yml" "nginx/default.conf"; do
    if [ ! -f "$pattern" ]; then
      echo "BLOCKED: infra-файл не найден: $PROJECT_DIR/$pattern"
      infra_lock_hint
      LAST_ERROR=1
      return 1
    fi
  done

  env_type="$(read_env_key ENV_TYPE)"
  db_name="$(read_env_key DB_NAME)"
  [ -n "$db_name" ] || db_name="$(read_env_key MYSQL_DATABASE)"

  config_file="$(mktemp)" || {
    echo "ОШИБКА: не удалось создать временный файл для docker compose config."
    LAST_ERROR=1
    return 1
  }

  if ! docker compose config > "$config_file"; then
    echo "BLOCKED: docker compose config не прошёл для $ENVIRONMENT."
    rm -f "$config_file"
    infra_lock_hint
    LAST_ERROR=1
    return 1
  fi

  case "$ENVIRONMENT" in
    PROD)
      if [ "$env_type" != "PROD" ]; then
        echo "BLOCKED: PROD требует ENV_TYPE=PROD, сейчас ENV_TYPE=${env_type:-empty}"
        rm -f "$config_file"
        infra_lock_hint
        LAST_ERROR=1
        return 1
      fi
      if [ "$db_name" != "jkh" ]; then
        echo "BLOCKED: PROD требует DB_NAME=jkh, сейчас DB_NAME=${db_name:-empty}"
        rm -f "$config_file"
        infra_lock_hint
        LAST_ERROR=1
        return 1
      fi
      required_config_patterns=(
        'container_name:[[:space:]]*jkh_nginx'
        'container_name:[[:space:]]*jkh_api'
        'container_name:[[:space:]]*jkh_mysql'
        'published:[[:space:]]*"*8081"*'
        'published:[[:space:]]*"*5000"*'
        'published:[[:space:]]*"*3306"*'
        'jkh_mysql_data'
      )
      forbidden_config_patterns=(
        'container_name:[[:space:]]*jkh_lab_'
        'published:[[:space:]]*"*8080"*'
        'published:[[:space:]]*"*5001"*'
        'published:[[:space:]]*"*3307"*'
        'DB_NAME([:=][[:space:]]*|=)jkh_lab'
        'ENV_TYPE([:=][[:space:]]*|=)LAB'
        'jkh_lab_mysql_data'
        'jkh-lab_mysql_data'
        'jkh_lab'
      )
      ;;
    LAB)
      if [ "$env_type" != "LAB" ]; then
        echo "BLOCKED: LAB требует ENV_TYPE=LAB, сейчас ENV_TYPE=${env_type:-empty}"
        rm -f "$config_file"
        infra_lock_hint
        LAST_ERROR=1
        return 1
      fi
      if [ "$db_name" != "jkh_lab" ]; then
        echo "BLOCKED: LAB требует DB_NAME=jkh_lab, сейчас DB_NAME=${db_name:-empty}"
        rm -f "$config_file"
        infra_lock_hint
        LAST_ERROR=1
        return 1
      fi
      required_config_patterns=(
        'container_name:[[:space:]]*jkh_lab_nginx'
        'container_name:[[:space:]]*jkh_lab_api'
        'container_name:[[:space:]]*jkh_lab_mysql'
        'published:[[:space:]]*"*8080"*'
        'published:[[:space:]]*"*5001"*'
        'published:[[:space:]]*"*3307"*'
        'jkh-lab_mysql_data'
      )
      forbidden_config_patterns=(
        'container_name:[[:space:]]*jkh_nginx'
        'container_name:[[:space:]]*jkh_api'
        'container_name:[[:space:]]*jkh_mysql'
        'published:[[:space:]]*"*8081"*'
        'published:[[:space:]]*"*5000"*'
        'published:[[:space:]]*"*3306"*'
        'DB_NAME([:=][[:space:]]*|=)jkh([^_[:alnum:]-]|$)'
        'ENV_TYPE([:=][[:space:]]*|=)PROD'
        'jkh_mysql_data'
      )
      ;;
    *)
      echo "ОШИБКА: неизвестная среда для infra guard: $ENVIRONMENT"
      rm -f "$config_file"
      LAST_ERROR=1
      return 1
      ;;
  esac

  for pattern in "${required_config_patterns[@]}"; do
    if ! grep -Eq "$pattern" "$config_file"; then
      echo "BLOCKED: $ENVIRONMENT docker compose config не содержит обязательный шаблон: $pattern"
      rm -f "$config_file"
      infra_lock_hint
      LAST_ERROR=1
      return 1
    fi
  done

  for pattern in "${forbidden_config_patterns[@]}"; do
    if grep -Eq "$pattern" "$config_file"; then
      echo "BLOCKED: $ENVIRONMENT docker compose config содержит запрещённый шаблон: $pattern"
      rm -f "$config_file"
      infra_lock_hint
      LAST_ERROR=1
      return 1
    fi
  done

  rm -f "$config_file"
  echo "OK: infra guard пройден для $ENVIRONMENT."
}

environment_guard() {
  case "$ENVIRONMENT" in
    LAB)
      if [ "$PROJECT_DIR" != "/root/jkh-lab" ] || [ "$MYSQL_CONTAINER" != "jkh_lab_mysql" ]; then
        echo "ОШИБКА: LAB environment guard не пройден."
        LAST_ERROR=1
        return 1
      fi
      ;;
    PROD)
      if [ "$PROJECT_DIR" != "/root/jkh" ] || [ "$MYSQL_CONTAINER" != "jkh_mysql" ]; then
        echo "ОШИБКА: PROD environment guard не пройден."
        LAST_ERROR=1
        return 1
      fi
      ;;
    *)
      echo "ОШИБКА: неизвестная среда для environment guard: $ENVIRONMENT"
      LAST_ERROR=1
      return 1
      ;;
  esac

  echo "OK: environment guard пройден для $ENVIRONMENT."
}

environment_compose_guard() {
  environment_guard || return 1
  infra_files_guard || return 1
}

environment_compose_guard_only() {
  environment_compose_guard || return 1
}

compose_restart() {
  environment_compose_guard || return 1
  run docker compose restart
}

compose_up_build() {
  environment_compose_guard || return 1
  run docker compose up -d --build
}

show_final_status() {
  echo
  print_line
  echo "ИТОГОВАЯ ПРОВЕРКА | $ENVIRONMENT"
  print_line

  echo
  echo "1. Текущая папка:"
  pwd || true

  echo
  echo "2. Текущая ветка:"
  git branch --show-current || true

  echo
  echo "3. git status -sb:"
  git status -sb || true

  echo
  echo "4. Последние 3 коммита:"
  git log --oneline -n 3 || true

  echo
  echo "5. docker compose ps:"
  docker compose ps || true

  wait_for_containers

  echo
  echo "6. Статус сайта:"
  check_site || true

  echo
  echo "7. Статус API:"
  check_api || true
}

check_result() {
  if [ "$LAST_BLOCKED" -eq 1 ]; then
    blocked
  elif [ "$LAST_ERROR" -eq 0 ]; then
    success
  else
    fail
  fi
}

scenario_header() {
  local number="$1"
  local title="$2"

  print_line
  echo "ПУНКТ $number"
  echo "======="
  echo
  echo "$title"
  echo
}

scenario_block() {
  local what="$1"
  local when="$2"
  local changes="$3"
  local not_changes="$4"
  local risk="$5"
  local simple="$6"
  local schema="$7"

  echo "Что делает:"
  echo "$what"
  echo
  echo "Когда использовать:"
  echo "$when"
  echo
  echo "Что изменяет:"
  echo "$changes"
  echo
  echo "Что НЕ изменяет:"
  echo "$not_changes"
  echo
  echo "Риск:"
  echo "$risk"
  echo
  echo "Простое объяснение:"
  echo "$simple"
  echo
  echo "Схема:"
  printf '%b\n' "$schema"
  echo
  show_context
}

explain() {
  case "$1" in
    1)
      scenario_header 1 "Обновление main без build"
      scenario_block \
        "Переключается на main, забирает свежие изменения с GitHub и перезапускает контейнеры без пересборки образов." \
        "Когда в main были обычные изменения кода, HTML, JS или настроек, но не менялись Dockerfile, requirements.txt и системные зависимости." \
        "Git-ветку в выбранной среде и запущенные контейнеры через docker compose restart." \
        "Базу данных, Docker-образы и локальные untracked-файлы. Очистка untracked-файлов не выполняется." \
        "Средний. В PROD перед запуском нужен YES_PROD и backup MySQL." \
        "Это быстрый способ обновить сервер до свежего main без долгой пересборки." \
        "[GitHub main]\n|\nv\n[$ENVIRONMENT $PROJECT_DIR]\n\nЗатрагивается только выбранная среда."
      ;;
    2)
      scenario_header 2 "Жёсткий возврат на чистый main"
      scenario_block \
        "Забирает origin/main и делает текущую папку точной копией main по отслеживаемым Git-файлам." \
        "Только когда сервер запутался, локальные изменения мешают работе, и нужно вернуться к чистому main." \
        "Tracked-файлы Git в выбранной среде, затем перезапускает контейнеры." \
        "Untracked-файлы и папки. Очистка untracked-файлов не выполняется. В PROD docker compose down не выполняется." \
        "Опасный. Может удалить незакоммиченные tracked-изменения." \
        "Это аварийная кнопка: вернуть код сервера к main. Используй только если понимаешь, что локальные правки в tracked-файлах пропадут." \
        "[GitHub main]\n|\nv\n[Чистый $ENVIRONMENT $PROJECT_DIR]\n\nЛокальные tracked-правки будут потеряны."
      ;;
    3)
      scenario_header 3 "Main с build"
      scenario_block \
        "Только в PROD: переключается на main, забирает свежие изменения и запускает docker compose up -d --build." \
        "Когда в PROD менялись Dockerfile, requirements.txt, backend-зависимости или нужно гарантированно пересобрать контейнеры. В LAB main-сценарии запрещены." \
        "Git-ветку, Docker-образы и контейнеры выбранной среды." \
        "Базу данных и локальные untracked-файлы. Очистка untracked-файлов и docker compose down в PROD не выполняются." \
        "Опасный. Разрешён только в PROD после YES_PROD, backup MySQL, environment guard и branch guard." \
        "Это полное PROD-обновление main с пересборкой приложения. В LAB используй пункт 4/5 для тестовой ветки." \
        "[GitHub main]\n|\nv\n[$ENVIRONMENT $PROJECT_DIR]\n|\nv\n[Docker build + запуск]"
      ;;
    4)
      scenario_header 4 "Тестовая ветка с build"
      scenario_block \
        "Показывает remote-ветки origin/*, создаёт локальную ветку test-pr из выбранной ветки и запускает build." \
        "Для проверки PR/Codex ветки, особенно если менялись backend, зависимости или Docker-настройки." \
        "Текущую Git-ветку выбранной среды, локальную ветку test-pr, Docker-образы и контейнеры." \
        "GitHub-ветки, базу данных и локальные untracked-файлы. PROD не трогается, если выбрана LAB." \
        "Средний для LAB, опасный для PROD." \
        "Берём выбранную ветку с GitHub и запускаем её в выбранной среде с пересборкой." \
        "[GitHub ветка]\n|\nv\n[$ENVIRONMENT $PROJECT_DIR]\n\nЕсли выбрана LAB, PROD НЕ ТРОГАЕМ."
      ;;
    5)
      scenario_header 5 "Тестовая ветка без build"
      scenario_block \
        "Показывает remote-ветки origin/*, создаёт локальную ветку test-pr и делает docker compose restart без build." \
        "Для быстрой проверки UI/HTML/JS или мелких изменений, когда пересборка Docker не нужна." \
        "Текущую Git-ветку выбранной среды и состояние контейнеров через restart." \
        "Docker-образы, базу данных, GitHub-ветки и локальные untracked-файлы." \
        "Средний для LAB, опасный для PROD." \
        "Быстро подставляем тестовую ветку в выбранную среду и перезапускаем приложение." \
        "[GitHub ветка]\n|\nv\n[$ENVIRONMENT $PROJECT_DIR]\n\nDocker build не выполняется."
      ;;
    6)
      scenario_header 6 "Restart docker"
      scenario_block \
        "Перезапускает контейнеры командой docker compose restart." \
        "Когда код уже на месте, но нужно перезапустить сервисы после сбоя или ручной правки конфигурации." \
        "Только работающие контейнеры выбранной среды." \
        "Git, базу данных, Docker-образы и файлы проекта." \
        "Средний. В PROD нужен YES_PROD, потому что сайт на короткое время может быть недоступен." \
        "Это выключить-включить контейнеры без изменения кода и без пересборки." \
        "[$ENVIRONMENT $PROJECT_DIR]\n|\nv\n[Restart контейнеров]\n\nКод не меняется."
      ;;
    7)
      scenario_header 7 "Базовые проверки"
      scenario_block \
        "Проверяет docker compose config, .env, MySQL, список контейнеров, сайт и API." \
        "Когда нужно понять, жив ли сервер и правильно ли настроена выбранная среда." \
        "Ничего. Это режим только чтения." \
        "Git, Docker-контейнеры, базу данных и файлы." \
        "Безопасный." \
        "Техосмотр без изменений: смотрим, всё ли отвечает." \
        "[$ENVIRONMENT]\n|\nv\n[Только чтение]\n\nНичего не изменяется."
      ;;
    8)
      scenario_header 8 "Логи nginx/api"
      scenario_block \
        "Показывает последние строки логов nginx и api." \
        "Когда сайт или API работают неправильно и нужно увидеть ошибку." \
        "Ничего. Только выводит текст логов." \
        "Git, Docker-контейнеры, базу данных и файлы." \
        "Безопасный." \
        "Это просмотр последних сообщений приложения, чтобы понять причину проблемы." \
        "[$ENVIRONMENT]\n|\nv\n[Логи nginx/api]\n\nТолько чтение."
      ;;
    9)
      scenario_header 9 "Безопасное обновление main"
      scenario_block \
        "Делает preflight-проверки, backup MySQL в PROD, обновляет main с build и проверяет результат." \
        "Для важного обновления main, особенно в PROD, когда нельзя рисковать базой и нужно пройти все проверки." \
        "Git-ветку, Docker-образы и контейнеры выбранной среды. В PROD создаёт backup MySQL." \
        "Локальные untracked-файлы, ветки на GitHub и базу данных напрямую. docker compose down в PROD не выполняется." \
        "Средний для LAB, опасный для PROD." \
        "Самый аккуратный путь: сначала проверяем, сохраняем базу, потом обновляем и снова проверяем." \
        "[GitHub main]\n|\nv\n[$ENVIRONMENT $PROJECT_DIR]\n|\nv\n[Backup в PROD + build + проверки]"
      ;;
    10)
      scenario_header 10 "Финальная техническая проверка"
      scenario_block \
        "Запускает backend-тесты внутри api, проверяет синтаксис важных JS-файлов, calc_engine guard, Docker, сайт и API." \
        "Перед merge, deploy или после серьёзных изменений." \
        "Ничего. Это проверка без deploy и restart." \
        "Git, Docker-контейнеры, Docker-образы, базу данных и файлы." \
        "Безопасный." \
        "Глубокий техосмотр проекта перед тем, как считать изменения готовыми." \
        "[$ENVIRONMENT]\n|\nv\n[Тесты и проверки]\n\nНичего не изменяется."
      ;;
    11)
      scenario_header 11 "Cherry-pick одного коммита"
      scenario_block \
        "Забирает данные с GitHub, показывает выбранный коммит, применяет его в текущую ветку и отдельно спрашивает, запускать ли build." \
        "Когда нужен ровно один конкретный коммит без полного переключения ветки." \
        "Текущую Git-ветку выбранной среды, Docker-образы и контейнеры." \
        "Другие коммиты, GitHub-ветки, untracked-файлы. В PROD docker compose down не выполняется." \
        "Опасный в PROD, средний в LAB." \
        "Это перенос одной точечной правки в текущую среду." \
        "[Выбранный commit]\n|\nv\n[$ENVIRONMENT $PROJECT_DIR]\n|\nv\n[Build + запуск]"
      ;;
    12)
      scenario_header 12 "Смена среды"
      scenario_block \
        "Меняет выбор между LAB и PROD." \
        "Когда нужно переключиться с тестовой среды на рабочую или обратно." \
        "Только выбор среды внутри меню." \
        "Git, Docker, базу данных, файлы и сайты." \
        "Безопасный." \
        "Меню просто начинает смотреть на другую папку и другой сайт." \
        "[LAB]\n^\n|\nv\n[PROD]\n\nМеняется только выбор среды."
      ;;
    13)
      scenario_header 13 "Dashboard"
      scenario_block \
        "Показывает короткую сводку по текущей среде: папка, ветка, git status, контейнеры, сайт, API, .env и lock." \
        "Когда нужно быстро понять, где ты находишься и что сейчас запущено." \
        "Ничего. Это режим только чтения." \
        "Git, Docker, базу данных и файлы." \
        "Безопасный." \
        "Один экран с главным состоянием выбранной среды." \
        "[$ENVIRONMENT]\n|\nv\n[Dashboard]\n\nТолько чтение."
      ;;
    14)
      scenario_header 14 "Rollback"
      scenario_block \
        "Возвращает текущую среду на указанный коммит или на предыдущий коммит HEAD~1 и запускает контейнеры без docker compose down." \
        "Когда после обновления стало хуже и нужно аккуратно вернуться к предыдущему состоянию кода." \
        "Git-состояние выбранной среды и контейнеры через restart или build." \
        "Untracked-файлы, базу данных и GitHub-ветки. docker compose down в PROD не выполняется." \
        "Опасный в PROD, средний в LAB." \
        "Это управляемый возврат к прошлому коду без удаления базы и без остановки compose через down." \
        "[Предыдущее состояние]\n|\nv\n[$ENVIRONMENT $PROJECT_DIR]\n\nВ PROD требуется отдельное YES_PROD."
      ;;
    15)
      scenario_header 15 "Проверка готовности LAB -> PROD"
      scenario_block \
        "Read-only preflight: проверяет Git, health, docker compose ps и sha256sum calc_engine в LAB и PROD без переноса." \
        "Когда нужно понять, можно ли готовить merge LAB-ветки в main перед PROD deploy." \
        "Ничего. Пункт только читает состояние LAB и PROD." \
        "LAB, PROD, Git, Docker, базу данных, файлы и контейнеры." \
        "Безопасный." \
        "Если всё хорошо, покажет READY. Если нет, покажет BLOCKED со списком причин." \
        "[LAB]\n|\nv\n[Read-only preflight]\n|\nv\n[PROD]\n\nПеренос НЕ выполняется."
      ;;
    16)
      scenario_header 16 "Backup текущей среды"
      scenario_block \
        "Создаёт MySQL dump текущей выбранной среды в /root/backups и показывает размер файла." \
        "Перед рискованными действиями или как ручная точка сохранения LAB/PROD." \
        "Только новый .sql файл backup. В PROD требует YES_PROD." \
        "Git, docker-compose.yml, Docker volumes, restore, docker down, ветки и код." \
        "Средний для LAB, опасный для PROD." \
        "Это только backup текущей базы выбранной среды. Восстановление здесь не реализовано." \
        "[$ENVIRONMENT MySQL]\n|\nv\n[/root/backups/${ENVIRONMENT,,}_backup_YYYY-MM-DD_HH-MM-SS.sql]"
      ;;
    17)
      scenario_header 17 "LAB -> PROD Deploy Wizard"
      scenario_block \
        "Показывает read-only проводник: текущий LAB-контекст, source branch, схему релиза и ручные шаги до PROD." \
        "Когда LAB проверен и нужно понять безопасный путь к PROD без прямого deploy из тестовой ветки." \
        "Ничего. Это инструкция и проверка состояния без изменений." \
        "Git, Docker, backup, deploy, файлы, БД, volumes и конфиги." \
        "Безопасный." \
        "Мастер объясняет правильный путь: LAB branch -> GitHub merge в main -> PROD backup -> deploy main -> health-check." \
        "[LAB test-pr]\n|\nv\n[GitHub source branch]\n|\nv\n[main]\n|\nv\n[PROD deploy from main]"
      ;;
    18)
      scenario_header 18 "Проверить LAB/PROD изоляцию"
      scenario_block \
        "Показывает Docker-контейнеры, volumes, mounts MySQL, ответы api/env и ожидаемый nginx routing для LAB и PROD." \
        "Когда нужно убедиться, что LAB и PROD не смешали контейнеры, порты, volumes и env." \
        "Ничего. Это режим только чтения." \
        "Git, Docker-контейнеры, volumes, базу данных и файлы." \
        "Безопасный." \
        "Проверка изоляции без изменений: только смотрим состояние двух сред." \
        "[PROD valvera.ru -> 8081]\n[LAB lab.valvera.ru -> 8080]\n\nТолько чтение."
      ;;
    *)
      echo "Нет такого пункта."
      return 1
      ;;
  esac
}

select_branch() {
  local branches=()
  local num manual_branch i b

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
    echo "Если ветка есть только на твоём компьютере, сначала сделай push на GitHub."
    LAST_ERROR=1
    return 1
  fi

  echo "Показаны все remote-ветки origin/*, кроме main."
  echo "0) Ввести имя ветки вручную"
  i=1
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
      echo "Сначала опубликуй ветку на GitHub."
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

show_cherry_pick_context() {
  local current_branch current_commit upstream

  current_branch="$(git branch --show-current 2>/dev/null || true)"
  current_commit="$(git rev-parse --short HEAD 2>/dev/null || true)"
  upstream="$(git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null || true)"

  echo
  print_line
  echo "CHERRY-PICK CONTEXT"
  print_line
  echo "Среда:          $ENVIRONMENT"
  echo "Текущая ветка:  ${current_branch:-unknown}"
  echo "Текущий commit: ${current_commit:-unknown}"
  echo "Upstream:       ${upstream:-нет upstream}"
  print_line
}

require_clean_git_status() {
  local changes

  changes="$(git status --porcelain)"
  if [ -z "$changes" ]; then
    echo "OK: git status чистый."
    return 0
  fi

  echo "ОШИБКА: перед cherry-pick git status должен быть чистым."
  echo "$changes"
  LAST_ERROR=1
  return 1
}

branch_guard() {
  local current_branch

  current_branch="$(git branch --show-current 2>/dev/null || true)"
  if [ -z "$current_branch" ]; then
    echo "ОШИБКА: не удалось определить текущую ветку."
    LAST_ERROR=1
    return 1
  fi

  if [ "$current_branch" = "main" ] && [ "$ENVIRONMENT" != "PROD" ]; then
    echo "ОШИБКА: ветка main разрешена только для PROD main-сценариев."
    LAST_ERROR=1
    return 1
  fi

  echo "OK: branch guard пройден. Текущая ветка: $current_branch"
}

select_cherry_pick_source_branch() {
  local branches=()
  local num manual_branch manual_confirm i b

  echo
  print_line
  echo "SOURCE BRANCH ДЛЯ CHERRY-PICK"
  print_line

  run git fetch origin --prune || return 1

  mapfile -t branches < <(
    git branch -r \
      | sed 's#^[[:space:]]*origin/##' \
      | grep -v '^HEAD ' \
      | sort
  )

  if [ "${#branches[@]}" -eq 0 ]; then
    echo "ОШИБКА: не найдено remote-веток origin/*"
    LAST_ERROR=1
    return 1
  fi

  echo "Показаны remote-ветки origin/*."
  echo "0) Ручной ввод ветки"
  i=1
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
    read -rp "Для ручного ввода ветки напиши MANUAL_BRANCH: " manual_confirm
    if [ "$manual_confirm" != "MANUAL_BRANCH" ]; then
      echo "Операция отменена до выбора ветки."
      LAST_ERROR=1
      return 1
    fi

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
    echo "Выбрана ветка: $SELECTED_BRANCH"
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

validate_commit_hash() {
  local hash="$1"

  if ! [[ "$hash" =~ ^[0-9a-fA-F]{7,40}$ ]]; then
    block_operation "BLOCKED: невалидный commit hash"
    return 1
  fi

  if ! git cat-file -e "${hash}^{commit}" 2>/dev/null; then
    block_operation "BLOCKED: невалидный commit hash"
    return 1
  fi
}

commit_already_in_head() {
  local commit="$1"
  local selected_commit head_commit

  selected_commit="$(git rev-parse --verify "${commit}^{commit}" 2>/dev/null)" || return 1
  head_commit="$(git rev-parse --verify "HEAD^{commit}" 2>/dev/null)" || return 1

  if [ "$selected_commit" = "$head_commit" ]; then
    return 0
  fi

  git merge-base --is-ancestor "$selected_commit" "$head_commit" 2>/dev/null
}

select_cherry_pick_commit() {
  local commits=()
  local choice manual_hash i line full_hash short_hash subject marker

  run git fetch origin || return 1

  echo
  print_line
  echo "ПОСЛЕДНИЕ 20 КОММИТОВ origin/$SELECTED_BRANCH"
  print_line
  git log --oneline "origin/$SELECTED_BRANCH" -20 || return 1

  mapfile -t commits < <(git log --format='%H%x09%h%x09%s' "origin/$SELECTED_BRANCH" -20)
  if [ "${#commits[@]}" -eq 0 ]; then
    echo "ОШИБКА: в origin/$SELECTED_BRANCH не найдено коммитов."
    LAST_ERROR=1
    return 1
  fi

  echo
  echo "Выбор commit:"
  echo "MANUAL_HASH) Ручной ввод hash"
  i=1
  for line in "${commits[@]}"; do
    IFS=$'\t' read -r full_hash short_hash subject <<< "$line"
    marker="[NEW]"
    if commit_already_in_head "$full_hash"; then
      marker="[ALREADY IN CURRENT BRANCH]"
    fi
    echo "$i) $marker $short_hash $subject"
    i=$((i + 1))
  done

  echo
  read -rp "Выбери номер commit или MANUAL_HASH для ручного hash: " choice
  if [ "$choice" = "MANUAL_HASH" ]; then
    read -rp "Commit hash: " manual_hash
    validate_commit_hash "$manual_hash" || return 1
    SELECTED_COMMIT="$manual_hash"
    return 0
  fi

  if ! [[ "$choice" =~ ^[0-9]+$ ]]; then
    validate_commit_hash "$choice" || return 1
    return 1
  fi

  if [ "$choice" -lt 1 ] || [ "$choice" -gt "${#commits[@]}" ]; then
    echo "ОШИБКА: такого номера commit нет."
    LAST_ERROR=1
    return 1
  fi

  IFS=$'\t' read -r full_hash short_hash subject <<< "${commits[$((choice - 1))]}"
  validate_commit_hash "$full_hash" || return 1
  SELECTED_COMMIT="$full_hash"
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
  local branch commit calc_hash

  echo "Проверка локальных изменений web/calc_engine.js"
  if ! git diff --quiet HEAD -- web/calc_engine.js; then
    echo "CRITICAL: web/calc_engine.js изменён в рабочем дереве."
    echo "Финальная LAB-проверка требует отсутствие локального diff в web/calc_engine.js."
    git diff --stat HEAD -- web/calc_engine.js || true
    LAST_ERROR=1
    return 1
  fi

  branch="$(git branch --show-current 2>/dev/null || true)"
  commit="$(git rev-parse --short=12 HEAD 2>/dev/null || true)"
  if command -v sha256sum >/dev/null 2>&1; then
    calc_hash="$(sha256sum web/calc_engine.js | awk '{print $1}')"
  else
    calc_hash="$(shasum -a 256 web/calc_engine.js | awk '{print $1}')"
  fi

  echo
  print_line
  echo "LAB calc_engine info"
  print_line
  echo "Текущая ветка LAB: ${branch:-unknown}"
  echo "Текущий commit LAB: ${commit:-unknown}"
  echo "sha256sum web/calc_engine.js: $calc_hash"
  echo "origin/main не используется как эталон для LAB-проверки"
  print_line
}

full_stage_verification() {
  echo
  print_line
  echo "ФИНАЛЬНАЯ ТЕХНИЧЕСКАЯ ПРОВЕРКА"
  print_line

  environment_compose_guard || return 1

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
  check_http_status "Сайт" "$SITE_CHECK" 200 || return 1
  check_api || return 1
}

PREFLIGHT_REASONS=()

preflight_add_reason() {
  PREFLIGHT_REASONS+=("$1")
}

print_block_reasons() {
  local i=1
  local reason

  for reason in "${LAST_BLOCK_REASONS[@]}"; do
    echo "$i) $reason"
    i=$((i + 1))
  done
}

print_preflight_next_steps_ready() {
  echo
  echo "Следующие шаги:"
  echo "1) merge LAB branch -> main через GitHub"
  echo "2) backup PROD через пункт 16"
  echo "3) deploy PROD из main"
  echo "4) health-check PROD"
}

print_preflight_next_steps_blocked() {
  echo
  echo "Что делать дальше:"
  echo "1) cd /root/jkh"
  echo "2) git status -sb"
  echo "3) исправить причины"
  echo "4) вернуться в LAB и снова запустить пункт 15"
}

preflight_http_check() {
  local label="$1"
  local url="$2"
  shift 2
  local status curl_code expected

  status="$(curl -sS -o /dev/null -w "%{http_code}" "$url")"
  curl_code=$?
  echo "$label: $url -> HTTP $status"
  if [ "$curl_code" -ne 0 ]; then
    preflight_add_reason "$label не прошёл: $url -> HTTP $status"
    return 0
  fi

  for expected in "$@"; do
    if [ "$status" = "$expected" ]; then
      return 0
    fi
  done

  preflight_add_reason "$label не прошёл: $url -> HTTP $status"
}

preflight_git_report() {
  local label="$1"
  local dir="$2"
  local branch status commit calc_hash

  echo
  print_line
  echo "$label | Git"
  print_line

  if [ ! -d "$dir/.git" ]; then
    echo "BLOCK: $dir не является git-репозиторием."
    preflight_add_reason "$label git repo не найден: $dir"
    return 0
  fi

  branch="$(git -C "$dir" branch --show-current 2>/dev/null || true)"
  commit="$(git -C "$dir" rev-parse --short=12 HEAD 2>/dev/null || true)"
  status="$(git -C "$dir" status --short 2>/dev/null || true)"

  echo "Папка: $dir"
  echo "Текущая ветка: ${branch:-unknown}"
  echo "Последний commit: ${commit:-unknown}"
  echo "git status:"
  if [ -n "$status" ]; then
    echo "$status"
    preflight_add_reason "$label git status не чистый"
  else
    echo "OK: clean"
  fi

  if [ ! -f "$dir/scripts/jkh_server_menu_v5_3.sh" ]; then
    echo "BLOCK: scripts/jkh_server_menu_v5_3.sh не найден."
    preflight_add_reason "$label scripts/jkh_server_menu_v5_3.sh не найден"
  else
    echo "OK: scripts/jkh_server_menu_v5_3.sh найден."
  fi

  if [ ! -f "$dir/web/calc_engine.js" ]; then
    echo "BLOCK: web/calc_engine.js не найден."
    preflight_add_reason "$label web/calc_engine.js не найден"
  elif command -v sha256sum >/dev/null 2>&1; then
    calc_hash="$(sha256sum "$dir/web/calc_engine.js" | awk '{print $1}')"
    echo "sha256sum web/calc_engine.js: $calc_hash"
  elif command -v shasum >/dev/null 2>&1; then
    calc_hash="$(shasum -a 256 "$dir/web/calc_engine.js" | awk '{print $1}')"
    echo "sha256sum web/calc_engine.js: $calc_hash"
  else
    echo "BLOCK: sha256sum/shasum не найден."
    preflight_add_reason "$label sha256sum недоступен"
  fi
}

preflight_docker_ps() {
  local label="$1"
  local dir="$2"

  echo
  print_line
  echo "$label | docker compose ps"
  print_line

  if [ ! -f "$dir/docker-compose.yml" ]; then
    echo "BLOCK: docker-compose.yml не найден в $dir"
    preflight_add_reason "$label docker-compose.yml не найден"
    return 0
  fi

  if ! (cd "$dir" && docker compose ps); then
    preflight_add_reason "$label docker compose ps не прошёл"
  fi
}

lab_prod_readiness_preflight() {
  local lab_dir="/root/jkh-lab"
  local prod_dir="/root/jkh"

  PREFLIGHT_REASONS=()

  echo
  print_line
  echo "Проверка готовности LAB -> PROD"
  print_line
  echo "Read-only preflight. Перенос, merge, deploy, backup, reset и запись файлов НЕ выполняются."
  print_line

  preflight_git_report "LAB" "$lab_dir"
  preflight_git_report "PROD" "$prod_dir"

  echo
  print_line
  echo "Health LAB"
  print_line
  preflight_http_check "LAB site" "http://127.0.0.1:8080" "200" "302"
  preflight_http_check "LAB API auth" "http://127.0.0.1:8080/api/auth/me" "401"

  echo
  print_line
  echo "Health PROD"
  print_line
  preflight_http_check "PROD site" "http://127.0.0.1/" "200" "302"
  preflight_http_check "PROD API auth" "http://127.0.0.1/api/auth/me" "401"

  preflight_docker_ps "LAB" "$lab_dir"
  preflight_docker_ps "PROD" "$prod_dir"

  echo
  print_line
  echo "ИТОГ LAB -> PROD PREFLIGHT"
  print_line
  if [ "${#PREFLIGHT_REASONS[@]}" -eq 0 ]; then
    echo "READY: можно готовить merge в main"
    print_preflight_next_steps_ready
    return 0
  fi

  LAST_BLOCK_REASONS=("${PREFLIGHT_REASONS[@]}")
  echo "BLOCKED:"
  print_block_reasons
  print_preflight_next_steps_blocked
  block_operation "BLOCKED:"
  return 1
}

wizard_add_reason_if_dirty_git() {
  local label="$1"
  local dir="$2"
  local status

  status="$(git -C "$dir" status --short 2>/dev/null || true)"
  if [ -n "$status" ]; then
    PREFLIGHT_REASONS+=("$label git status не чистый")
  fi
}

wizard_collect_visible_blockers() {
  local lab_dir="/root/jkh-lab"
  local prod_dir="/root/jkh"

  PREFLIGHT_REASONS=()

  if [ ! -d "$lab_dir/.git" ]; then
    PREFLIGHT_REASONS+=("LAB git repo не найден: $lab_dir")
  else
    wizard_add_reason_if_dirty_git "LAB" "$lab_dir"
    [ -f "$lab_dir/scripts/jkh_server_menu_v5_3.sh" ] || PREFLIGHT_REASONS+=("LAB scripts/jkh_server_menu_v5_3.sh не найден")
    [ -f "$lab_dir/web/calc_engine.js" ] || PREFLIGHT_REASONS+=("LAB web/calc_engine.js не найден")
  fi

  if [ ! -d "$prod_dir/.git" ]; then
    PREFLIGHT_REASONS+=("PROD git repo не найден: $prod_dir")
  else
    wizard_add_reason_if_dirty_git "PROD" "$prod_dir"
    [ -f "$prod_dir/scripts/jkh_server_menu_v5_3.sh" ] || PREFLIGHT_REASONS+=("PROD scripts/jkh_server_menu_v5_3.sh не найден")
    [ -f "$prod_dir/web/calc_engine.js" ] || PREFLIGHT_REASONS+=("PROD web/calc_engine.js не найден")
  fi
}

lab_prod_deploy_wizard() {
  local lab_dir="/root/jkh-lab"
  local branch upstream source_branch head_commit lab_site lab_api

  echo
  print_line
  echo "LAB -> PROD DEPLOY WIZARD"
  print_line
  echo "Read-only. Wizard НЕ делает git checkout/reset/merge/push, docker compose, backup, deploy, запись файлов или изменение БД."
  print_line

  if [ ! -d "$lab_dir/.git" ]; then
    echo "BLOCKED: LAB git repo не найден: $lab_dir"
    block_operation "BLOCKED: LAB git repo не найден"
    return 1
  fi

  branch="$(git -C "$lab_dir" branch --show-current 2>/dev/null || true)"
  upstream="$(git -C "$lab_dir" rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null || true)"
  source_branch="${upstream#origin/}"
  [ -n "$upstream" ] || source_branch="${branch:-unknown}"
  head_commit="$(git -C "$lab_dir" log --oneline -1 2>/dev/null || true)"

  echo "ТЕКУЩИЙ КОНТЕКСТ LAB"
  echo "Среда:        LAB"
  echo "Папка:        $lab_dir"
  echo "Текущая ветка: ${branch:-unknown}"
  echo "Upstream:     ${upstream:-нет upstream}"
  echo "HEAD commit:  ${head_commit:-unknown}"
  echo "git status:"
  git -C "$lab_dir" status -sb || true

  echo
  print_line
  echo "Health LAB"
  print_line
  lab_site="$(curl -sS -o /dev/null -w "%{http_code}" "http://127.0.0.1:8080" 2>/dev/null || true)"
  lab_api="$(curl -sS -o /dev/null -w "%{http_code}" "http://127.0.0.1:8080/api/auth/me" 2>/dev/null || true)"
  echo "LAB site: http://127.0.0.1:8080 -> HTTP ${lab_site:-000}"
  echo "LAB API auth: http://127.0.0.1:8080/api/auth/me -> HTTP ${lab_api:-000}"

  echo
  print_line
  echo "ПРАВИЛЬНАЯ СХЕМА"
  print_line
  echo "LAB server branch ${branch:-unknown}"
  echo "-> GitHub branch ${source_branch:-unknown}"
  echo "-> merge into main on GitHub"
  echo "-> PROD server deploy from main"

  echo
  print_line
  echo "НЕЛЬЗЯ"
  print_line
  echo "- НЕЛЬЗЯ переключать LAB-сервер в main."
  echo "- НЕЛЬЗЯ деплоить PROD напрямую из codex/* ветки."
  echo "- НЕЛЬЗЯ копировать файлы LAB -> PROD руками."
  echo "- НЕЛЬЗЯ переносить LAB-базу в PROD."
  echo "- НЕЛЬЗЯ делать restore LAB backup в PROD."
  echo "- НЕЛЬЗЯ менять docker-compose.yml вручную ради релиза."

  wizard_collect_visible_blockers
  if [ "$lab_site" != "200" ] && [ "$lab_site" != "302" ]; then
    PREFLIGHT_REASONS+=("LAB site health не прошёл: HTTP ${lab_site:-000}")
  fi
  if [ "$lab_api" != "401" ]; then
    PREFLIGHT_REASONS+=("LAB API health не прошёл: HTTP ${lab_api:-000}")
  fi

  echo
  print_line
  echo "СТАТУС ПЕРЕД ШАГАМИ"
  print_line
  if [ "${#PREFLIGHT_REASONS[@]}" -gt 0 ]; then
    LAST_BLOCK_REASONS=("${PREFLIGHT_REASONS[@]}")
    echo "Сначала исправь причины пункта 15. Merge/deploy пока нельзя."
    echo
    echo "BLOCKED:"
    print_block_reasons
    block_operation "BLOCKED:"
    return 1
  fi

  echo "Можно готовить merge source branch -> main."

  echo
  print_line
  echo "ЧТО ДЕЛАТЬ"
  print_line
  echo "Шаг 1:"
  echo "Запустить пункт 15 и добиться READY."
  echo
  echo "Шаг 2:"
  echo "В GitHub Desktop или GitHub Web сделать:"
  echo "merge ${source_branch:-source-branch} -> main"
  echo
  echo "Шаг 3:"
  echo "Перейти в PROD:"
  echo "cd /root/jkh"
  echo "bash scripts/jkh_server_menu_v5_3.sh"
  echo
  echo "Шаг 4:"
  echo "Сделать backup PROD:"
  echo "пункт 16"
  echo
  echo "Шаг 5:"
  echo "Обновить PROD из main:"
  echo "пункт 1 — если обычные изменения кода"
  echo "пункт 3 — если менялись Dockerfile / requirements.txt / зависимости"
  echo
  echo "Шаг 6:"
  echo "Проверить PROD:"
  echo "пункт 7 или пункт 10"
  echo "curl -i http://127.0.0.1/api/auth/me"
}

run_basic_checks() {
  environment_compose_guard || return 1
  run docker compose config --quiet || return 1
  load_env || return 1
  run mysql_app_check || return 1
  run docker compose ps || return 1
  health_check || return 1
}

check_lab_prod_isolation() {
  echo
  print_line
  echo "ПРОВЕРКА LAB/PROD ИЗОЛЯЦИИ"
  print_line
  echo "Read-only. Команды изменения Docker, Git, файлов, volumes и БД НЕ выполняются."

  echo
  print_line
  echo "docker ps"
  print_line
  docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Ports}}\t{{.Status}}' || true

  echo
  print_line
  echo "docker volume ls"
  print_line
  docker volume ls || true

  echo
  print_line
  echo "docker inspect mounts | PROD jkh_mysql"
  print_line
  docker inspect jkh_mysql --format '{{range .Mounts}}{{println .Name "->" .Destination}}{{end}}' 2>/dev/null || echo "jkh_mysql не найден"

  echo
  print_line
  echo "docker inspect mounts | LAB jkh_lab_mysql"
  print_line
  docker inspect jkh_lab_mysql --format '{{range .Mounts}}{{println .Name "->" .Destination}}{{end}}' 2>/dev/null || echo "jkh_lab_mysql не найден"

  echo
  print_line
  echo "curl valvera.ru/api/env"
  print_line
  curl -sS -i --max-time 10 http://valvera.ru/api/env || true

  echo
  print_line
  echo "curl lab.valvera.ru/api/env"
  print_line
  curl -sS -i --max-time 10 http://lab.valvera.ru/api/env || true

  echo
  print_line
  echo "Ожидаемый nginx routing"
  print_line
  echo "valvera.ru     -> 127.0.0.1:8081 -> PROD nginx/api/mysql"
  echo "lab.valvera.ru -> 127.0.0.1:8080 -> LAB nginx/api/mysql"

  echo
  echo "Проверка nginx/default.conf в PROD:"
  if [ -f /root/jkh/nginx/default.conf ]; then
    grep -nE 'server_name|proxy_pass|8081|8080' /root/jkh/nginx/default.conf || true
  else
    echo "/root/jkh/nginx/default.conf не найден"
  fi

  echo
  echo "Проверка nginx/default.conf в LAB:"
  if [ -f /root/jkh-lab/nginx/default.conf ]; then
    grep -nE 'server_name|proxy_pass|8081|8080' /root/jkh-lab/nginx/default.conf || true
  else
    echo "/root/jkh-lab/nginx/default.conf не найден"
  fi
}

dashboard() {
  echo
  print_line
  echo "DASHBOARD | $ENVIRONMENT"
  print_line
  show_context

  echo
  echo "Git branch:"
  git branch --show-current || true

  echo
  echo "Git status:"
  git status -sb || true

  echo
  echo "Последние 3 коммита:"
  git log --oneline -n 3 || true

  echo
  echo ".env:"
  if [ -f "$ENV_FILE" ]; then
    echo "OK: $ENV_FILE найден."
  else
    echo "ОШИБКА: $ENV_FILE не найден."
    LAST_ERROR=1
  fi

  echo
  echo "Lock:"
  if [ -f "$LOCK_FILE" ]; then
    echo "ВНИМАНИЕ: lock-файл существует:"
    cat "$LOCK_FILE" || true
  else
    echo "OK: активного lock-файла нет."
  fi

  echo
  echo "Docker:"
  docker compose ps || true

  health_check || true
}

deploy_main_no_build() {
  local infra_snapshot

  require_main_scenario_prod || return 1
  prepare_deploy "Обновление main без build" "yes" || return 1
  infra_snapshot="$(mktemp)" || return 1
  infra_snapshot_before_git "$infra_snapshot" || return 1
  run_git_preserving_infra "$infra_snapshot" git checkout main || return 1
  run_git_preserving_infra "$infra_snapshot" git pull --ff-only origin main || return 1
  prod_main_branch_guard || return 1
  environment_compose_guard_only || return 1
  compose_restart || return 1
}

hard_reset_main() {
  local answer infra_snapshot

  require_main_scenario_prod || return 1
  require_prod_confirmation "Жёсткий возврат на чистый main" || return 1
  echo
  echo "Это действие выполнит git reset --hard origin/main."
  echo "Tracked-изменения в Git будут потеряны."
  echo "Очистка untracked-файлов не будет выполнена, untracked-файлы не удаляются."
  read -rp "Для подтверждения введи RESET_MAIN: " answer
  if [ "$answer" != "RESET_MAIN" ]; then
    echo "Операция отменена до изменений Git и Docker."
    LAST_ERROR=1
    return 1
  fi

  if [ "$ENVIRONMENT" = "PROD" ]; then
    create_mysql_backup || return 1
  fi

  run git fetch origin || return 1
  infra_snapshot="$(mktemp)" || return 1
  infra_snapshot_before_git "$infra_snapshot" || return 1
  run_git_preserving_infra "$infra_snapshot" git checkout main || return 1
  run_git_preserving_infra "$infra_snapshot" git reset --hard origin/main || return 1
  prod_main_branch_guard || return 1
  environment_compose_guard_only || return 1
  compose_restart || return 1
}

deploy_main_with_build() {
  local infra_snapshot

  require_main_scenario_prod || return 1
  prepare_deploy "Обновление main с docker build" "yes" || return 1
  infra_snapshot="$(mktemp)" || return 1
  infra_snapshot_before_git "$infra_snapshot" || return 1
  run_git_preserving_infra "$infra_snapshot" git checkout main || return 1
  run_git_preserving_infra "$infra_snapshot" git pull --ff-only origin main || return 1
  prod_main_branch_guard || return 1
  environment_compose_guard_only || return 1
  compose_up_build || return 1
}

deploy_test_branch() {
  local with_build="$1"
  local description="Тестовая ветка без build"
  local infra_snapshot
  [ "$with_build" = "yes" ] && description="Тестовая ветка с build"

  prepare_deploy "$description" "yes" || return 1
  select_branch || return 1
  infra_snapshot="$(mktemp)" || return 1
  infra_snapshot_before_git "$infra_snapshot" || return 1
  run_git_preserving_infra "$infra_snapshot" git checkout -B test-pr "origin/$SELECTED_BRANCH" || return 1
  environment_compose_guard_only || return 1

  if [ "$with_build" = "yes" ]; then
    compose_up_build || return 1
  else
    compose_restart || return 1
  fi
}

restart_services() {
  require_prod_confirmation "Restart контейнеров PROD" || return 1
  compose_restart
}

safe_main_deploy() {
  local infra_snapshot

  require_main_scenario_prod || return 1
  prepare_deploy "Безопасное обновление main: backup + build + проверки" "yes" || return 1
  if [ "$ENVIRONMENT" = "LAB" ]; then
    load_env || return 1
    run mysql_app_check || return 1
    check_api || return 1
  fi
  infra_snapshot="$(mktemp)" || return 1
  infra_snapshot_before_git "$infra_snapshot" || return 1
  run_git_preserving_infra "$infra_snapshot" git checkout main || return 1
  run_git_preserving_infra "$infra_snapshot" git pull --ff-only origin main || return 1
  prod_main_branch_guard || return 1
  environment_compose_guard_only || return 1
  compose_up_build || return 1
  wait_for_containers
  run mysql_app_check || return 1
  health_check || return 1
}

cherry_pick_commit() {
  local answer build_answer infra_snapshot

  require_prod_confirmation "Cherry-pick одного коммита" || return 1
  show_cherry_pick_context
  require_clean_git_status || return 1
  environment_compose_guard || return 1
  branch_guard || return 1
  if [ "$ENVIRONMENT" = "PROD" ]; then
    create_mysql_backup || return 1
    run mysql_app_check || return 1
    check_api || return 1
  fi

  select_cherry_pick_source_branch || return 1
  select_cherry_pick_commit || return 1

  if commit_already_in_head "$SELECTED_COMMIT"; then
    block_operation "BLOCKED: этот commit уже есть в текущей ветке"
    return 1
  fi

  run git show --stat "$SELECTED_COMMIT" || return 1
  infra_snapshot="$(mktemp)" || return 1
  infra_snapshot_before_git "$infra_snapshot" || return 1
  read -rp "Применить этот коммит? Напиши y: " answer
  if [ "$answer" != "y" ]; then
    echo "Операция отменена до cherry-pick и Docker build."
    LAST_ERROR=1
    return 1
  fi

  echo
  echo ">>> git cherry-pick $SELECTED_COMMIT"
  git cherry-pick "$SELECTED_COMMIT"
  local code=$?
  infra_check_after_git "$infra_snapshot" || return 1
  if [ "$code" -ne 0 ]; then
    if [ -f .git/CHERRY_PICK_HEAD ] || [ -n "$(git diff --name-only --diff-filter=U)" ]; then
      echo "git cherry-pick --abort"
      echo "git status -sb"
      block_operation "BLOCKED: cherry-pick требует ручного разрешения конфликта"
    else
      LAST_ERROR=$code
    fi
    return 1
  fi

  echo
  echo "git status после cherry-pick:"
  git status -sb || true
  echo
  echo "Новый HEAD:"
  git log --oneline -n 1 || true

  environment_compose_guard || return 1
  read -rp "Запускать build после успешного cherry-pick? Напиши y: " build_answer
  if [ "$build_answer" != "y" ]; then
    echo "Build не запускался."
    return 0
  fi

  compose_up_build || return 1
}

safe_rollback() {
  local target build_answer confirm_answer infra_snapshot

  require_prod_confirmation "Rollback выбранной среды" || return 1

  echo
  echo "Rollback НЕ выполняет docker compose down."
  echo "Можно вернуться на конкретный commit или на HEAD~1."
  echo "Текущая среда: $ENVIRONMENT"
  echo "Папка: $PROJECT_DIR"
  echo
  read -rp "Commit для rollback или Enter для HEAD~1: " target
  target="${target:-HEAD~1}"

  echo
  echo "Будет выполнено:"
  echo "git reset --hard $target"
  echo "затем docker compose restart или docker compose up -d --build по выбору"
  echo
  echo "Очистка untracked-файлов НЕ выполняется."
  echo "docker compose down НЕ выполняется."
  echo "База данных НЕ откатывается."
  echo

  if [ "$ENVIRONMENT" = "PROD" ]; then
    create_mysql_backup || return 1
    read -rp "Для rollback в PROD ещё раз введи YES_PROD: " confirm_answer
    if [ "$confirm_answer" != "YES_PROD" ]; then
      echo "Rollback отменён до изменений Git и Docker."
      LAST_ERROR=1
      return 1
    fi
  else
    read -rp "Для rollback введи ROLLBACK: " confirm_answer
    if [ "$confirm_answer" != "ROLLBACK" ]; then
      echo "Rollback отменён."
      LAST_ERROR=1
      return 1
    fi
  fi

  run git rev-parse --verify "$target" || return 1
  infra_snapshot="$(mktemp)" || return 1
  infra_snapshot_before_git "$infra_snapshot" || return 1
  run_git_preserving_infra "$infra_snapshot" git reset --hard "$target" || return 1
  environment_compose_guard_only || return 1

  read -rp "Нужен build после rollback? Напиши y для build, Enter для restart: " build_answer
  if [ "$build_answer" = "y" ]; then
    compose_up_build || return 1
  else
    compose_restart || return 1
  fi
}

run_case() {
  SELECTED_COMMIT=""
  LAST_ERROR=0
  LAST_BLOCKED=0
  BLOCKED_MESSAGE=""
  LAST_BLOCK_REASONS=()
  go_project || {
    show_final_status
    check_result
    return
  }

  acquire_lock || {
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
    13) dashboard ;;
    14) safe_rollback || true ;;
    15) lab_prod_readiness_preflight || true ;;
    16) backup_current_environment || true ;;
    17) lab_prod_deploy_wizard || true ;;
    18) check_lab_prod_isolation || true ;;
    *)
      echo "Нет такого пункта."
      LAST_ERROR=1
      ;;
  esac

  release_lock
  show_final_status
  check_result
}

menu() {
  clear
  print_line
  echo "ПАПАЖКХ SERVER MENU $VERSION | $ENVIRONMENT"
  echo "$PROJECT_DIR | $SITE_CHECK"
  print_line
  echo "1) Обновление main без build"
  echo "2) Жёсткий возврат на чистый main"
  echo "3) Main с build"
  echo "4) Тестовая ветка с build"
  echo "5) Тестовая ветка без build"
  echo "6) Restart docker"
  echo "7) Базовые проверки"
  echo "8) Логи nginx/api"
  echo "9) Безопасное обновление main"
  echo "10) Финальная техническая проверка"
  echo "11) Cherry-pick одного коммита"
  echo "12) Сменить LAB/PROD"
  echo "13) Dashboard среды"
  echo "14) Rollback"
  echo "15) Проверка готовности LAB -> PROD"
  echo "16) Backup текущей среды"
  echo "17) LAB -> PROD Deploy Wizard"
  echo "18) Проверить LAB/PROD изоляцию"
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
      explain "$choice" || {
        pause
        continue
      }
      read -rp "Сменить среду? Напиши y: " confirm
      if [ "$confirm" = "y" ]; then
        select_environment
      fi
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
