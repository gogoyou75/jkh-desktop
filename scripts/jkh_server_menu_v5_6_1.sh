#!/usr/bin/env bash
# ============================================================
# JKH SERVER MENU v5.6.1 (LAB / PROD, protected operations)
# ============================================================

set -u

VERSION="v5.6.1"

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
  local lock_pid lock_metadata cleanup_code
  [ "$LOCK_HELD" -eq 1 ] || return 0

  if [ ! -e "$LOCK_FILE" ] && [ ! -L "$LOCK_FILE" ]; then
    LOCK_HELD=0
    return 0
  fi
  if [ -L "$LOCK_FILE" ] || ! IFS=' ' read -r lock_pid lock_metadata < "$LOCK_FILE"; then
    echo "ERROR: cannot verify ownership of lock: $LOCK_FILE"
    return 1
  fi
  if [ "$lock_pid" != "pid=$$" ]; then
    echo "ERROR: lock ownership changed; leaving lock untouched: $LOCK_FILE"
    return 1
  fi

  if rm -f -- "$LOCK_FILE"; then
    LOCK_HELD=0
    return 0
  else
    cleanup_code=$?
    echo "ERROR: cannot remove owned lock: $LOCK_FILE"
    return "$cleanup_code"
  fi
}

trap cleanup_lock EXIT INT TERM

acquire_lock() {
  if ! ( set -C; printf '%s\n' "pid=$$ env=$ENVIRONMENT dir=$PROJECT_DIR date=$(date '+%F %T')" > "$LOCK_FILE" ) 2>/dev/null; then
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

  LOCK_HELD=1
}

release_lock() {
  cleanup_lock
}

site_url_for_environment() {
  case "$1" in
    LOCAL_LAB)
      case "${CUP_LOCAL_SITE_CHECK:-}" in
        http://127.0.0.1:*|http://localhost:*) printf '%s\n' "$CUP_LOCAL_SITE_CHECK" ;;
        *) return 1 ;;
      esac ;;
    LAB) printf '%s\n' "http://127.0.0.1:8080" ;;
    PROD) printf '%s\n' "http://127.0.0.1:8081" ;;
    *) return 1 ;;
  esac
}

api_url_for_site() {
  printf '%s/api/auth/me\n' "${1%/}"
}

set_environment_vars() {
  case "$1" in
    LOCAL_LAB)
      if [ -z "${CUP_LOCAL_PROJECT_DIR:-}" ] || [ -z "${CUP_LOCAL_MYSQL_CONTAINER:-}" ] ||
         [ -z "${CUP_LOCAL_SITE_CHECK:-}" ]; then
        block_operation "BLOCKED: explicit LOCAL LAB configuration required"
        return 1
      fi
      ENVIRONMENT="LOCAL_LAB"
      PROJECT_DIR="$CUP_LOCAL_PROJECT_DIR"
      MYSQL_CONTAINER="$CUP_LOCAL_MYSQL_CONTAINER"
      ;;
    LAB)
      ENVIRONMENT="LAB"
      PROJECT_DIR="/root/jkh-lab"
      MYSQL_CONTAINER="jkh_lab_mysql"
      ;;
    PROD)
      ENVIRONMENT="PROD"
      PROJECT_DIR="/root/jkh"
      MYSQL_CONTAINER="jkh_mysql"
      ;;
    *)
      echo "ОШИБКА: неизвестная среда: $1"
      LAST_ERROR=1
      return 1
      ;;
  esac

  ENV_FILE="$PROJECT_DIR/.env"
  if [ "$ENVIRONMENT" = "LOCAL_LAB" ]; then
    BACKUP_DIR="$PROJECT_DIR/.schema-state/LOCAL_LAB/backups"
    MANUAL_BACKUP_DIR="$PROJECT_DIR/.schema-state/LOCAL_LAB/manual-backups"
  else
    BACKUP_DIR="/root/jkh_backups"
    MANUAL_BACKUP_DIR="/root/backups"
  fi
  SITE_CHECK="$(site_url_for_environment "$ENVIRONMENT")" || return 1
  API_CHECK="$(api_url_for_site "$SITE_CHECK")"
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
    echo "2) PROD (/root/jkh,     http://127.0.0.1:8081)"
    echo "   Рабочая среда. Опасные действия требуют YES_PROD и backup MySQL."
    echo
    echo "3) LOCAL LAB (explicit local project configuration)"
    echo "0) Выход"
    echo
    read -rp "Выбери среду: " choice

    case "$choice" in
      1) set_environment_vars "LAB" ;;
      2) set_environment_vars "PROD" ;;
      3) set_environment_vars "LOCAL_LAB" || { pause; continue; } ;;
      0) exit 0 ;;
      *)
        echo "Нет такой среды."
        pause
        continue
        ;;
    esac

    if [ ! -d "$PROJECT_DIR/.git" ] && { [ "$ENVIRONMENT" != "LOCAL_LAB" ] || [ ! -f "$PROJECT_DIR/.git" ]; }; then
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

  if [ ! -d ".git" ] && { [ "$ENVIRONMENT" != "LOCAL_LAB" ] || [ ! -f ".git" ]; }; then
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
  MYSQL_PWD="$MYSQL_ROOT_PASSWORD" docker exec -e MYSQL_PWD "$MYSQL_CONTAINER" \
    mysqldump -u root --single-transaction --routines --triggers \
    "$DB_NAME_EFFECTIVE" > "$backup_file"
}

mysql_app_check() {
  MYSQL_PWD="$DB_PASSWORD_EFFECTIVE" docker exec -e MYSQL_PWD "$MYSQL_CONTAINER" \
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
    LOCAL_LAB) backup_db="jkh_local_lab" ;;
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
  MYSQL_PWD="$MYSQL_ROOT_PASSWORD" docker exec -e MYSQL_PWD "$MYSQL_CONTAINER" \
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

infra_skip_worktree_block() {
  echo "BLOCKED: server-local infra не защищена skip-worktree."
  echo "Команды исправления:"
  echo "git update-index --skip-worktree docker-compose.yml nginx/default.conf"
  echo "После этого:"
  echo "git ls-files -v docker-compose.yml nginx/default.conf"
}

check_skip_worktree_infra() {
  local compose_line nginx_line env_line

  compose_line="$(git ls-files -v -- docker-compose.yml 2>/dev/null || true)"
  nginx_line="$(git ls-files -v -- nginx/default.conf 2>/dev/null || true)"
  env_line="$(git ls-files -v -- .env 2>/dev/null || true)"

  case "$compose_line" in
    S[[:space:]]*docker-compose.yml) ;;
    *)
      infra_skip_worktree_block
      LAST_ERROR=1
      return 1
      ;;
  esac

  case "$nginx_line" in
    S[[:space:]]*nginx/default.conf) ;;
    *)
      infra_skip_worktree_block
      LAST_ERROR=1
      return 1
      ;;
  esac

  if [ -z "$env_line" ]; then
    echo "OK: .env not tracked, Git его не трогает"
    return 0
  fi

  case "$env_line" in
    S[[:space:]]*.env)
      echo "OK: .env tracked и защищён skip-worktree"
      ;;
    *)
      echo "BLOCKED: .env tracked, но не защищён skip-worktree."
      echo "Команды исправления:"
      echo "git update-index --skip-worktree .env"
      echo "После этого:"
      echo "git ls-files -v .env"
      LAST_ERROR=1
      return 1
      ;;
  esac
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
    backup_dir="$(grep '^BACKUP_DIR=' "$snapshot_file" | tail -n 1 | cut -d= -f2-)"

    if [ -n "$backup_dir" ] && [ -d "$backup_dir" ]; then
      echo "BLOCKED: git-операция изменила infra-файлы выбранной среды."
      echo
      echo "Было до git:"
      tail -n +2 "$snapshot_file" || true
      echo
      echo "Стало после git:"
      cat "$current_file" || true
      echo
      echo "ENVIRONMENT=$ENVIRONMENT"
      echo "PROJECT_DIR=$PROJECT_DIR"
      echo "Восстанавливаю server-local infra выбранной среды из локального backup:"
      echo ".env"
      echo "docker-compose.yml"
      echo "nginx/default.conf"

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
        if infra_files_guard; then
          echo "OK: infra-файлы выбранной среды восстановлены; сценарий продолжается"
          rm -f "$current_file"
          rm -rf "$backup_dir"
          return 0
        fi

        echo "BLOCKED: восстановленные infra-файлы не прошли guard выбранной среды."
        rm -f "$current_file"
        rm -rf "$backup_dir"
        block_operation "BLOCKED: restored infra guard failed"
        infra_lock_hint
        return 1
      fi
    fi

    echo "BLOCKED: infra-файлы не удалось восстановить в состояние выбранной среды."
    rm -f "$current_file"
    [ -n "$backup_dir" ] && rm -rf "$backup_dir"
    infra_lock_hint
    LAST_ERROR=1
    return 1
  fi

  rm -f "$current_file"
  backup_dir="$(grep '^BACKUP_DIR=' "$snapshot_file" | tail -n 1 | cut -d= -f2-)"
  [ -n "$backup_dir" ] && rm -rf "$backup_dir"
  echo "OK: infra-файлы не изменились после git-операции."
  return 0
}

v541_run_git_preserving_infra() {
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

# Align only the index entries for protected LAB files before switching branches.
# Their server-local working copies remain untouched throughout the checkout.
lab_checkout_test_branch_preserving_infra() (
  local target="${SCHEMA_PINNED_TARGET:-origin/$SELECTED_BRANCH}"
  local path current_entry target_entry mode current_mode oid stage kind listed_path
  local original_head original_branch completed=0
  local -a protected_paths=(docker-compose.yml nginx/default.conf)
  local -a original_entries=() target_entries=()
  local i

  [ "$ENVIRONMENT" = "LAB" ] || [ "$ENVIRONMENT" = "LOCAL_LAB" ] || return 1
  original_head="$(git rev-parse HEAD)" || return 1
  original_branch="$(git symbolic-ref --quiet --short HEAD)" || return 1
  git rev-parse --verify --quiet "$target^{commit}" >/dev/null || return 1

  if [ -n "$(git ls-files -- .env)" ]; then
    protected_paths+=(.env)
  fi

  for path in "${protected_paths[@]}"; do
    current_entry="$(git ls-files --stage -- "$path")" || return 1
    target_entry="$(git ls-tree "$target" -- "$path")" || return 1
    read -r mode oid stage listed_path <<< "$current_entry"
    if [ -z "$current_entry" ] || [ "$stage" != 0 ] || [ "$listed_path" != "$path" ]; then
      block_operation "BLOCKED: индекс LAB infra-файла не готов: $path"
      return 1
    fi
    if ! git diff --cached --quiet HEAD -- "$path"; then
      block_operation "BLOCKED: LAB infra-файл подготовлен к коммиту: $path"
      return 1
    fi
    current_mode="$mode"
    original_entries+=("$mode,$oid,$path")
    read -r mode kind oid listed_path <<< "$target_entry"
    if [ "$kind" != blob ] || [ "$listed_path" != "$path" ] ||
       [ "$mode" != "$current_mode" ]; then
      block_operation "BLOCKED: LAB infra-файл отсутствует или сменил тип в целевой ветке: $path"
      return 1
    fi
    target_entries+=("$mode,$oid,$path")
  done

  restore_lab_index_on_failure() {
    if [ "$completed" -eq 0 ]; then
      for i in "${!protected_paths[@]}"; do
        git update-index --cacheinfo "${original_entries[$i]}" &&
          git update-index --skip-worktree "${protected_paths[$i]}" ||
          echo "BLOCKED: не удалось восстановить индекс для ${protected_paths[$i]}"
      done
      if [ "$(git rev-parse HEAD)" != "$original_head" ] ||
         [ "$(git symbolic-ref --quiet --short HEAD)" != "$original_branch" ]; then
        echo "BLOCKED: Git изменил HEAD при неудачном checkout; требуется ручная проверка."
      fi
    fi
  }
  trap restore_lab_index_on_failure EXIT

  for i in "${!protected_paths[@]}"; do
    git update-index --cacheinfo "${target_entries[$i]}" || return 1
    git update-index --skip-worktree "${protected_paths[$i]}" || return 1
  done

  git checkout -B test-pr "$target" || return 1
  completed=1
)

infra_files_guard() {
  if [ "$ENVIRONMENT" = "LOCAL_LAB" ]; then local_infra_guard; return $?; fi
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
    LOCAL_LAB)
      if [ -z "${CUP_LOCAL_PROJECT_DIR:-}" ] || [ "$PROJECT_DIR" != "$CUP_LOCAL_PROJECT_DIR" ] ||
         [ "$MYSQL_CONTAINER" != "${CUP_LOCAL_MYSQL_CONTAINER:-}" ]; then
        block_operation "BLOCKED: LOCAL LAB identity mismatch"
        return 1
      fi
      case "$PROJECT_DIR" in /root/*) block_operation "BLOCKED: server path in LOCAL LAB"; return 1 ;; esac
      case "$MYSQL_CONTAINER" in jkh_local_*|cup_*) ;; *) block_operation "BLOCKED: non-local container"; return 1 ;; esac
      ;;
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
  schema_current_gate || return 1
  run docker compose restart
}

compose_up_build() {
  environment_compose_guard || return 1
  schema_current_gate || return 1
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
        "Базу данных, Docker-образы и локальные untracked-файлы. server-local infra: .env, docker-compose.yml, nginx/default.conf, container_name, ports, volumes, DB_NAME, ENV_TYPE." \
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
        "Untracked-файлы и папки. server-local infra: .env, docker-compose.yml, nginx/default.conf, container_name, ports, volumes, DB_NAME, ENV_TYPE. В PROD docker compose down не выполняется." \
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
        "Базу данных и локальные untracked-файлы. server-local infra: .env, docker-compose.yml, nginx/default.conf, container_name, ports, volumes, DB_NAME, ENV_TYPE. Очистка untracked-файлов и docker compose down в PROD не выполняются." \
        "Опасный. Разрешён только в PROD после YES_PROD, backup MySQL, environment guard и branch guard." \
        "Это полное PROD-обновление main с пересборкой приложения. В LAB используй пункт 4/5 для тестовой ветки." \
        "[GitHub main]\n|\nv\n[$ENVIRONMENT $PROJECT_DIR]\n|\nv\n[Docker build + запуск]"
      ;;
    4)
      scenario_header 4 "Тестовая ветка с build"
      scenario_block \
        "Показывает remote-ветки origin/*, создаёт локальную ветку test-pr из выбранной ветки и запускает build." \
        "Разрешено только в LAB. Для проверки PR/Codex ветки, особенно если менялись backend, зависимости или Docker-настройки. PROD не запускает тестовые ветки." \
        "Текущую Git-ветку выбранной среды, локальную ветку test-pr, Docker-образы и контейнеры." \
        "GitHub-ветки, базу данных и локальные untracked-файлы. server-local infra: .env, docker-compose.yml, nginx/default.conf, container_name, ports, volumes, DB_NAME, ENV_TYPE. PROD не трогается, если выбрана LAB." \
        "Средний для LAB, опасный для PROD." \
        "Берём выбранную ветку с GitHub и запускаем её в выбранной среде с пересборкой." \
        "[GitHub ветка]\n|\nv\n[$ENVIRONMENT $PROJECT_DIR]\n\nЕсли выбрана LAB, PROD НЕ ТРОГАЕМ."
      ;;
    5)
      scenario_header 5 "Тестовая ветка без build"
      scenario_block \
        "Показывает remote-ветки origin/*, создаёт локальную ветку test-pr и делает docker compose restart без build." \
        "Разрешено только в LAB. Для быстрой проверки UI/HTML/JS или мелких изменений, когда пересборка Docker не нужна. PROD не запускает тестовые ветки." \
        "Текущую Git-ветку выбранной среды и состояние контейнеров через restart." \
        "Docker-образы, базу данных, GitHub-ветки и локальные untracked-файлы. server-local infra: .env, docker-compose.yml, nginx/default.conf, container_name, ports, volumes, DB_NAME, ENV_TYPE." \
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
        "Локальные untracked-файлы, ветки на GitHub и базу данных напрямую. server-local infra: .env, docker-compose.yml, nginx/default.conf, container_name, ports, volumes, DB_NAME, ENV_TYPE. docker compose down в PROD не выполняется." \
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
        "Другие коммиты, GitHub-ветки, untracked-файлы. server-local infra: .env, docker-compose.yml, nginx/default.conf, container_name, ports, volumes, DB_NAME, ENV_TYPE. В PROD docker compose down не выполняется." \
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
        "Untracked-файлы, базу данных и GitHub-ветки. server-local infra: .env, docker-compose.yml, nginx/default.conf, container_name, ports, volumes, DB_NAME, ENV_TYPE. docker compose down в PROD не выполняется." \
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
    19) echo "Управление схемой: диагностика, согласованный план, проверенный backup и Alembic. Изменения требуют отдельного подтверждения." ;;
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
  schema_current_gate || return 1

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
  if [ "$ENVIRONMENT" = "LOCAL_LAB" ]; then
    block_operation "BLOCKED: VPS cross-environment report is unavailable in LOCAL LAB"
    return 1
  fi
  local lab_dir="/root/jkh-lab"
  local prod_dir="/root/jkh"
  local lab_site prod_site lab_api prod_api

  lab_site="$(site_url_for_environment LAB)" || return 1
  prod_site="$(site_url_for_environment PROD)" || return 1
  lab_api="$(api_url_for_site "$lab_site")"
  prod_api="$(api_url_for_site "$prod_site")"

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
  preflight_http_check "LAB site" "$lab_site" "200" "302"
  preflight_http_check "LAB API auth" "$lab_api" "401"

  echo
  print_line
  echo "Health PROD"
  print_line
  preflight_http_check "PROD site" "$prod_site" "200" "302"
  preflight_http_check "PROD API auth" "$prod_api" "401"

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
  if [ "$ENVIRONMENT" = "LOCAL_LAB" ]; then
    block_operation "BLOCKED: VPS cross-environment report is unavailable in LOCAL LAB"
    return 1
  fi
  local lab_dir="/root/jkh-lab"
  local branch upstream source_branch head_commit lab_site lab_api prod_api

  lab_site="$(site_url_for_environment LAB)" || return 1
  lab_api="$(api_url_for_site "$lab_site")"
  prod_api="$(api_url_for_site "$(site_url_for_environment PROD)")" || return 1

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
  local lab_site_status lab_api_status
  lab_site_status="$(curl -sS -o /dev/null -w "%{http_code}" "$lab_site" 2>/dev/null || true)"
  lab_api_status="$(curl -sS -o /dev/null -w "%{http_code}" "$lab_api" 2>/dev/null || true)"
  echo "LAB site: $lab_site -> HTTP ${lab_site_status:-000}"
  echo "LAB API auth: $lab_api -> HTTP ${lab_api_status:-000}"

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
  if [ "$lab_site_status" != "200" ] && [ "$lab_site_status" != "302" ]; then
    PREFLIGHT_REASONS+=("LAB site health не прошёл: HTTP ${lab_site_status:-000}")
  fi
  if [ "$lab_api_status" != "401" ]; then
    PREFLIGHT_REASONS+=("LAB API health не прошёл: HTTP ${lab_api_status:-000}")
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
  echo "curl -i $prod_api"
}

run_basic_checks() {
  environment_compose_guard || return 1
  schema_current_gate || return 1
  run docker compose config --quiet || return 1
  load_env || return 1
  run mysql_app_check || return 1
  run docker compose ps || return 1
  health_check || return 1
}

check_lab_prod_isolation() {
  if [ "$ENVIRONMENT" = "LOCAL_LAB" ]; then
    block_operation "BLOCKED: VPS cross-environment report is unavailable in LOCAL LAB"
    return 1
  fi
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
  echo "S = Git не трогает server-local infra при обновлениях."

  echo
  print_line
  echo "git ls-files -v docker-compose.yml nginx/default.conf .env 2>/dev/null || true"
  print_line
  git ls-files -v docker-compose.yml nginx/default.conf .env 2>/dev/null || true

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
  check_skip_worktree_infra || return 1
  prepare_deploy "Обновление main без build" "yes" || return 1
  infra_snapshot="$(mktemp)" || return 1
  infra_snapshot_before_git "$infra_snapshot" || return 1
  run_git_preserving_infra "$infra_snapshot" git checkout main || return 1
  infra_snapshot="$(mktemp)" || return 1
  infra_snapshot_before_git "$infra_snapshot" || return 1
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

  check_skip_worktree_infra || return 1
  run git fetch origin || return 1
  infra_snapshot="$(mktemp)" || return 1
  infra_snapshot_before_git "$infra_snapshot" || return 1
  run_git_preserving_infra "$infra_snapshot" git checkout main || return 1
  infra_snapshot="$(mktemp)" || return 1
  infra_snapshot_before_git "$infra_snapshot" || return 1
  run_git_preserving_infra "$infra_snapshot" git reset --hard origin/main || return 1
  prod_main_branch_guard || return 1
  environment_compose_guard_only || return 1
  compose_restart || return 1
}

deploy_main_with_build() {
  local infra_snapshot

  require_main_scenario_prod || return 1
  check_skip_worktree_infra || return 1
  prepare_deploy "Обновление main с docker build" "yes" || return 1
  infra_snapshot="$(mktemp)" || return 1
  infra_snapshot_before_git "$infra_snapshot" || return 1
  run_git_preserving_infra "$infra_snapshot" git checkout main || return 1
  infra_snapshot="$(mktemp)" || return 1
  infra_snapshot_before_git "$infra_snapshot" || return 1
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

  if [ "$ENVIRONMENT" = "PROD" ]; then
    block_operation "BLOCKED: тестовые ветки запрещены в PROD. Сначала проверь ветку в LAB, затем merge в main, затем deploy PROD из main."
    return 1
  fi

  check_skip_worktree_infra || return 1
  prepare_deploy "$description" "yes" || return 1
  select_branch || return 1
  infra_snapshot="$(mktemp)" || return 1
  infra_snapshot_before_git "$infra_snapshot" || return 1
  run_git_preserving_infra "$infra_snapshot" lab_checkout_test_branch_preserving_infra || return 1
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
  check_skip_worktree_infra || return 1
  prepare_deploy "Безопасное обновление main: backup + build + проверки" "yes" || return 1
  if [ "$ENVIRONMENT" = "LAB" ]; then
    load_env || return 1
    run mysql_app_check || return 1
    check_api || return 1
  fi
  infra_snapshot="$(mktemp)" || return 1
  infra_snapshot_before_git "$infra_snapshot" || return 1
  run_git_preserving_infra "$infra_snapshot" git checkout main || return 1
  infra_snapshot="$(mktemp)" || return 1
  infra_snapshot_before_git "$infra_snapshot" || return 1
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
  check_skip_worktree_infra || return 1
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
  schema_target_gate "$SELECTED_COMMIT" cherry-pick || return 1
  git cherry-pick "$SCHEMA_PINNED_TARGET"
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

  check_skip_worktree_infra || return 1
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
  local operation_rc=0 cleanup_rc=0 final_status_rc=0 operation_error=0
  SELECTED_COMMIT=""
  LAST_ERROR=0
  LAST_BLOCKED=0
  BLOCKED_MESSAGE=""
  LAST_BLOCK_REASONS=()
  if go_project; then
    if acquire_lock; then
      case "$1" in
        1) deploy_main_no_build || operation_rc=$? ;;
        2) hard_reset_main || operation_rc=$? ;;
        3) deploy_main_with_build || operation_rc=$? ;;
        4) deploy_test_branch "yes" || operation_rc=$? ;;
        5) deploy_test_branch "no" || operation_rc=$? ;;
        6) restart_services || operation_rc=$? ;;
        7) run_basic_checks || operation_rc=$? ;;
        8) show_logs || operation_rc=$? ;;
        9) safe_main_deploy || operation_rc=$? ;;
        10) full_stage_verification || operation_rc=$? ;;
        11) cherry_pick_commit || operation_rc=$? ;;
        13) dashboard || operation_rc=$? ;;
        14) safe_rollback || operation_rc=$? ;;
        15) lab_prod_readiness_preflight || operation_rc=$? ;;
        16) backup_current_environment || operation_rc=$? ;;
        17) lab_prod_deploy_wizard || operation_rc=$? ;;
        18) check_lab_prod_isolation || operation_rc=$? ;;
      19) schema_menu || operation_rc=$? ;;
        *)
          echo "Нет такого пункта."
          LAST_ERROR=1
          operation_rc=1
          ;;
      esac
    else
      operation_rc=$?
    fi
  else
    operation_rc=$?
  fi

  # Preserve errors even when the handler did not update the shared flags.
  if [ "$operation_rc" -ne 0 ] && [ "$LAST_ERROR" -eq 0 ]; then
    LAST_ERROR=$operation_rc
  fi
  operation_error=$LAST_ERROR

  # Always attempt owned-lock cleanup; neither cleanup nor reporting may hide
  # the original operation failure. BLOCKED remains the highest-priority status.
  release_lock || cleanup_rc=$?
  show_final_status || final_status_rc=$?
  if [ "$operation_error" -ne 0 ]; then
    LAST_ERROR=$operation_error
  elif [ "$cleanup_rc" -ne 0 ]; then
    LAST_ERROR=$cleanup_rc
  elif [ "$LAST_ERROR" -eq 0 ] && [ "$final_status_rc" -ne 0 ]; then
    LAST_ERROR=$final_status_rc
  fi

  check_result
  if [ "$LAST_BLOCKED" -eq 1 ] || [ "$LAST_ERROR" -ne 0 ]; then
    return 1
  fi
  return 0
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
  echo "19) Управление структурой базы данных"
  echo "0) Выход"
  echo
}


# Schema Control is the only migration entry point. Bash never executes DDL.
local_infra_guard() {
  local config_file result endpoint="${DOCKER_HOST:-}"
  if [ -z "$endpoint" ]; then
    endpoint="$(docker context inspect --format '{{.Endpoints.docker.Host}}')" || return 1
  fi
  case "$endpoint" in unix://*|npipe://*) ;; *) block_operation "BLOCKED: LOCAL requires a local Docker engine"; return 1 ;; esac
  config_file="$(mktemp)" || return 1
  chmod 600 "$config_file" || return 1
  if ! docker compose config --format json > "$config_file"; then
    block_operation "BLOCKED: cannot inspect LOCAL compose"
    return 1
  fi
  if "${CUP_HOST_PYTHON:-python3}" - "$config_file" "$MYSQL_CONTAINER" "$PROJECT_DIR" <<'LOCAL_CONFIG_CHECK'
import json, sys
from pathlib import Path
try:
    config=json.loads(Path(sys.argv[1]).read_text())
    name=config.get('name','')
    assert name.startswith(('jkh_local','cup_'))
    services=config['services'];api=services['api']['environment'];mysql=services['mysql']
    assert api.get('ENV_TYPE')=='LOCAL_LAB' and api.get('DB_HOST')=='mysql'
    assert api.get('DB_NAME')=='jkh_local_lab' and api.get('DB_USER')=='jkh_local'
    assert mysql.get('container_name')==sys.argv[2]
    for service in services.values():
        container=service.get('container_name','')
        assert not container or container.startswith(('jkh_local','cup_'))
        for port in service.get('ports',[]):
            assert port.get('host_ip') in ('127.0.0.1','::1')
    for volume in config.get('volumes',{}).values():
        assert not volume.get('external')
        assert volume.get('name',name).startswith((name,'jkh_local','cup_'))
    root=str(Path(sys.argv[3]).resolve())
    for volume in mysql.get('volumes',[]):
        if volume.get('type')=='bind':
            assert Path(volume['source']).resolve().is_relative_to(Path(root))
except Exception:
    raise SystemExit(1)
LOCAL_CONFIG_CHECK
  then result=0; else result=$?; fi
  rm -f -- "$config_file"
  if [ "$result" -ne 0 ]; then block_operation "BLOCKED: LOCAL compose identity/isolation mismatch"; return 1; fi
}

schema_profile() {
  case "$ENVIRONMENT" in
    LAB) printf '%s\n' VPS_LAB ;;
    LOCAL_LAB|PROD) printf '%s\n' "$ENVIRONMENT" ;;
    *) return 1 ;;
  esac
}

# Configuration files are explicitly selected by the owner; source them only
# inside the tool subshell. Do not expose administrative settings to the API.
schema_environment() {
  local action="$1" file prefix key name
  for file in "${CUP_SCHEMA_DB_ENV_FILE:-}" "${CUP_SCHEMA_ADMIN_ENV_FILE:-}" "${CUP_SCHEMA_RESTORE_ENV_FILE:-}"; do
    [ -n "$file" ] || continue
    [ -f "$file" ] && [ -r "$file" ] || { printf '%s\n' '{"status":"BLOCKED","reason":"schema_environment_file_unreadable"}'; return 2; }
    set -a
    if source "$file" >/dev/null 2>&1; then set +a; else set +a; printf '%s\n' '{"status":"BLOCKED","reason":"credential_file_invalid"}'; return 2; fi
  done
  for prefix in '' MAINT_ RESTORE_; do
    if [ "$prefix" = RESTORE_ ] && [ "$action" != backup ]; then continue; fi
    for key in ENV_TYPE DB_HOST DB_PORT DB_NAME DB_USER DB_PASSWORD; do
      name="$prefix$key"
      [ -n "${!name:-}" ] || { printf '{"status":"BLOCKED","reason":"required_connection_variable_missing:%s"}\n' "$name"; return 2; }
      export "$name"
    done
  done
  [ "$ENV_TYPE" = "$ENVIRONMENT" ] && [ "$MAINT_ENV_TYPE" = "$ENV_TYPE" ] &&
    [ "$MAINT_DB_HOST" = "$DB_HOST" ] && [ "$MAINT_DB_PORT" = "$DB_PORT" ] &&
    [ "$MAINT_DB_NAME" = "$DB_NAME" ] || {
      printf '%s\n' '{"status":"BLOCKED","reason":"schema_environment_identity_mismatch"}'; return 2;
    }
}

schema_compose() (
  schema_environment diagnose || return 2
  docker compose "$@"
)

schema_compose_guard() (
  schema_environment diagnose || return 2
  environment_compose_guard
)

schema_cli_scoped() (
  local action="$1" profile backend_mount state_mount code
  shift
  profile="$(schema_profile)" || return 1
  schema_environment "$action" || return 2
  environment_compose_guard || return 2
  schema_writer_services >/dev/null || { block_operation 'BLOCKED: unreviewed services or administrative credentials exposed to writers'; return 2; }
  mkdir -p "$PROJECT_DIR/.schema-state/$ENVIRONMENT" || return 1
  chmod 700 "$PROJECT_DIR/.schema-state" "$PROJECT_DIR/.schema-state/$ENVIRONMENT" || return 1
  backend_mount="$PROJECT_DIR/backend"
  state_mount="$PROJECT_DIR/.schema-state/$ENVIRONMENT"
  if command -v cygpath >/dev/null 2>&1; then
    backend_mount="$(cygpath -w "$backend_mount")" || return 1
    state_mount="$(cygpath -w "$state_mount")" || return 1
  fi
  # Build/run a one-off tool, never start the API service. The host state mount
  # survives application rebuilds; source code is read-only inside the tool.
  if MSYS_NO_PATHCONV=1 docker compose run --rm --no-deps --build --entrypoint python \
    -v "$backend_mount:/cup-schema-code:ro" \
    -v "$state_mount:/cup-schema-state" \
    -e CUP_SCHEMA_STATE_DIR=/cup-schema-state -e CUP_MAINTENANCE_POLICY=/cup-schema-state/policy.json -e PYTHONDONTWRITEBYTECODE=1 \
    -e ENV_TYPE -e DB_HOST -e DB_PORT -e DB_NAME -e DB_USER -e DB_PASSWORD \
    -e MAINT_ENV_TYPE -e MAINT_DB_HOST -e MAINT_DB_PORT -e MAINT_DB_NAME -e MAINT_DB_USER -e MAINT_DB_PASSWORD \
    -e RESTORE_ENV_TYPE -e RESTORE_DB_HOST -e RESTORE_DB_PORT \
    -e RESTORE_DB_NAME -e RESTORE_DB_USER -e RESTORE_DB_PASSWORD \
    api /cup-schema-code/schema_control.py "$action" --profile "$profile" "$@"; then
    return 0
  else
    code=$?
  fi
  return "$code"
)

schema_cli() {
  local code
  if schema_cli_scoped "$@"; then return 0; else code=$?; fi
  if [ "$code" -eq 2 ]; then
    block_operation "BLOCKED: Schema Control refused the operation; see reason above"
  fi
  return "$code"
}

schema_current_gate() {
  if schema_cli check; then return 0; fi
  block_operation "BLOCKED: schema does not match the current backend; use menu 19"
  return 1
}

schema_target_gate() {
  local target="$1" mode="${2:-target}" sha bundle rel current ancestor proposed
  sha="$(git rev-parse --verify --end-of-options "$target^{commit}")" || return 1
  mkdir -p "$PROJECT_DIR/.schema-state/$ENVIRONMENT" || return 1
  bundle="$(mktemp -d "$PROJECT_DIR/.schema-state/$ENVIRONMENT/target.XXXXXX")" || return 1
  chmod 700 "$bundle" || return 1
  mkdir -p "$bundle/alembic" || return 1
  for rel in app.py schema_contract.json alembic/schema_snapshot.json; do
    if [ "$mode" = cherry-pick ]; then
      current="$bundle/current"; ancestor="$bundle/ancestor"; proposed="$bundle/proposed"
      git show "HEAD:backend/$rel" > "$current" 2>/dev/null || : > "$current"
      git show "$sha^:backend/$rel" > "$ancestor" 2>/dev/null || : > "$ancestor"
      git show "$sha:backend/$rel" > "$proposed" 2>/dev/null || : > "$proposed"
      if cmp -s "$ancestor" "$proposed"; then cp "$current" "$bundle/$rel" || return 1
      elif cmp -s "$current" "$ancestor"; then cp "$proposed" "$bundle/$rel" || return 1
      elif cmp -s "$current" "$proposed"; then cp "$current" "$bundle/$rel" || return 1
      elif ! git merge-file -p "$current" "$ancestor" "$proposed" > "$bundle/$rel"; then
        block_operation "BLOCKED: prospective schema contract conflicts during cherry-pick"
        return 1
      fi
    elif ! git show "$sha:backend/$rel" > "$bundle/$rel"; then
      block_operation "BLOCKED: target backend has no verified schema contract"
      return 1
    fi
  done
  if schema_cli check --target-package "/cup-schema-state/$(basename "$bundle")"; then
    SCHEMA_PINNED_TARGET="$sha"
    return 0
  fi
  block_operation "BLOCKED: database incompatible with target backend"
  return 1
}

run_git_preserving_infra() {
  local snapshot="$1" target code
  shift
  if [ "$1" = lab_checkout_test_branch_preserving_infra ]; then
    schema_target_gate "origin/$SELECTED_BRANCH" || return 1
    if v541_run_git_preserving_infra "$snapshot" "$@"; then code=0; else code=$?; fi
    SCHEMA_PINNED_TARGET=""
    return "$code"
  fi
  if [ "$1" = git ]; then
    case "$2" in
      checkout) run git fetch origin main || return 1; schema_target_gate origin/main || return 1 ;;
      pull)
        # Fetch once, validate its exact SHA, then fast-forward to that SHA.
        run git fetch origin main || return 1
        schema_target_gate origin/main || return 1
        v541_run_git_preserving_infra "$snapshot" git merge --ff-only "$SCHEMA_PINNED_TARGET"
        return $?
        ;;
      reset)
        target="${@: -1}"
        schema_target_gate "$target" || return 1
        v541_run_git_preserving_infra "$snapshot" git reset --hard "$SCHEMA_PINNED_TARGET"
        return $?
        ;;
    esac
  fi
  v541_run_git_preserving_infra "$snapshot" "$@"
}

schema_writer_services() {
  local config_file result
  config_file="$(mktemp)" || return 1
  chmod 600 "$config_file" || return 1
  if ! schema_compose config --format json > "$config_file"; then rm -f -- "$config_file"; return 1; fi
  if "${CUP_HOST_PYTHON:-python3}" - "$config_file" "$PROJECT_DIR/.schema-state/$ENVIRONMENT/policy.json" <<'WRITER_POLICY'
import json,sys,re
from pathlib import Path
reason='writer_policy_validation_failed'
try:
    reason='writer_compose_metadata_invalid'
    config=json.loads(Path(sys.argv[1]).read_text())
    reason='maintenance_policy_missing_or_invalid'
    policy=json.loads(Path(sys.argv[2]).read_text())
    services=policy['services']
    reason='maintenance_writer_services_invalid'
    assert isinstance(services,list) and services and 'api' in services
    assert len(services)==len(set(services))
    assert all(isinstance(s,str) and re.fullmatch(r'[a-z][a-z0-9_-]*',s) and s not in ('mysql','nginx') for s in services)
    reason='writer_services_do_not_match_policy'
    assert set(config['services'])-{'mysql','nginx'} == set(services)
    for service in services:
        reason='writer_environment_metadata_invalid'
        environment=config['services'][service].get('environment',{})
        reason='administrative_credentials_in_writer_environment'
        assert not any(k.startswith(('MAINT_','MIGRATION_','RESTORE_')) or k in ('MYSQL_ROOT_PASSWORD','MYSQL_ROOT_PASSWORD_FILE') for k in environment)
    print(' '.join(services))
except Exception:
    print(json.dumps({'status':'BLOCKED','reason':reason}),file=sys.stderr)
    raise SystemExit(1)
WRITER_POLICY
  then result=0; else result=$?; fi
  rm -f -- "$config_file"
  return "$result"
}

schema_maintenance_begin() {
  local services running profile
  profile="$(schema_profile)" || return 1
  v561_guard schema_compose_guard || return 2
  v561_guard schema_writer_services || return 2
  services="$CUP561_GUARD_OUTPUT"
  # Service names are strictly validated above. Stop all declared writers; never MySQL.
  running="$(schema_compose ps --status running --services $services)" || return 1
  mkdir -p "$PROJECT_DIR/.schema-state/$ENVIRONMENT" || return 1
  if [ ! -f "$PROJECT_DIR/.schema-state/$ENVIRONMENT/services-before.txt" ]; then
    (umask 077; printf '%s\n' "$running" > "$PROJECT_DIR/.schema-state/$ENVIRONMENT/services-before.txt") || return 1
  fi
  schema_compose stop --timeout 30 $services || return 1
  running="$(schema_compose ps --status running -q $services)" || return 1
  [ -z "$running" ] || { block_operation 'BLOCKED: writer services still running'; return 1; }
  schema_cli maintenance-begin --confirmation "FENCE $profile"
}

schema_maintenance_resume() {
  local profile services before service
  profile="$(schema_profile)" || return 1
  v561_guard schema_writer_services || return 2
  services="$CUP561_GUARD_OUTPUT"
  before="$PROJECT_DIR/.schema-state/$ENVIRONMENT/services-before.txt"
  if [ ! -f "$before" ]; then
    "${CUP_HOST_PYTHON:-python3}" - "$PROJECT_DIR/.schema-state/$ENVIRONMENT/maintenance.json" <<'RESUME_STATE' || { block_operation 'BLOCKED: missing original writer service state'; return 1; }
import json,sys
from pathlib import Path
try:
    assert json.loads(Path(sys.argv[1]).read_text())['phase']=='RESUMED'
except Exception:
    raise SystemExit(1)
RESUME_STATE
  fi
  # Schema Control verifies the schema under the fence BEFORE atomic unlock.
  schema_cli maintenance-resume --confirmation "RESUME $profile" || return 1
  before="$PROJECT_DIR/.schema-state/$ENVIRONMENT/services-before.txt"
  [ -f "$before" ] || return 0
  while IFS= read -r service; do
    [ -n "$service" ] || continue
    case " $services " in *" $service "*) ;; *) block_operation 'BLOCKED: unknown prior writer service'; return 1 ;; esac
    schema_compose start "$service" || return 1
  done < "$before"
  : # v5.6 retains original services until health/version verification succeeds
}

schema_plan() {
  local action=plan
  if [ -f "$PROJECT_DIR/.schema-state/$ENVIRONMENT/maintenance.json" ]; then
    if ! "${CUP_HOST_PYTHON:-python3}" - "$PROJECT_DIR/.schema-state/$ENVIRONMENT/maintenance.json" <<'FENCE_STATE'
import json,sys
from pathlib import Path
raise SystemExit(0 if json.loads(Path(sys.argv[1]).read_text())['phase']=='RESUMED' else 1)
FENCE_STATE
    then action=maintenance-plan; fi
  fi
  schema_cli "$action" "$@"
}

schema_menu() {
  local choice profile plan_file backup_id confirmation maintenance
  profile="$(schema_profile)" || return 1
  while true; do
    echo '19.1 — Диагностика структуры БД'
    echo '19.2 — Текущая и требуемая версии схемы'
    echo '19.3 — Доступные миграции'
    echo '19.4 — Предварительный план миграций'
    echo '19.5 — Резервное копирование и испытательное восстановление'
    echo '19.6 — Применение согласованного плана'
    echo '19.7 — Проверка результата и безопасное возобновление записей'
    echo '19.8 — Журнал операций'
    echo '0 — Назад'
    read -rp 'Выбери операцию: ' choice || return 1
    case "$choice" in
      0) return 0 ;;
      1|19.1) schema_cli diagnose || return 1 ;;
      2|19.2) schema_cli versions || return 1 ;;
      3|19.3) schema_cli migrations || return 1 ;;
      4|19.4)
        plan_file="/cup-schema-state/plan-$(date +%s)-$$-$RANDOM.json"
        schema_plan --output "$plan_file" || return 1
        SCHEMA_LAST_PLAN="$plan_file"
        ;;
      5|19.5)
        require_prod_confirmation 'Schema backup and isolated restore validation' || return 1
        read -rp 'Подтверди изолированную пустую restore-БД: RESTORE_TEST_DB: ' confirmation
        [ "$confirmation" = RESTORE_TEST_DB ] || { block_operation 'BLOCKED: isolated restore confirmation required'; return 1; }
        schema_maintenance_begin || return 1
        schema_cli backup || return 1
        ;;
      6|19.6)
        [ -n "${SCHEMA_LAST_PLAN:-}" ] || { block_operation 'BLOCKED: create a plan first'; return 1; }
        require_prod_confirmation 'Apply schema migrations' || return 1
        read -rp 'Backup ID из проверенного receipt: ' backup_id
        read -rp "Введи APPLY $profile <plan_id>: " confirmation
        schema_cli apply --plan "$SCHEMA_LAST_PLAN" --backup-id "$backup_id" --confirmation "$confirmation" || return 1
        ;;
      7|19.7)
        require_prod_confirmation 'Verify schema and resume writer access' || return 1
        read -rp 'Проверить схему и возобновить доступ? Введи RESUME: ' confirmation
        [ "$confirmation" = RESUME ] || { block_operation 'BLOCKED: resume confirmation required'; return 1; }
        schema_maintenance_resume || return 1 ;;

      8|19.8) schema_cli journal || return 1 ;;
      *) block_operation 'BLOCKED: unknown database operation'; return 1 ;;
    esac
    pause
  done
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

    # The result is already displayed; an ordinary failure must not exit the menu.
    run_case "$choice" || :
    pause
  done
}


# v5.6 UI/orchestration. Existing operation handlers above stay available.
V56_IMAGE=""
V56_FINGERPRINT=""
V56_OVERRIDE=""
V56_LAST_JSON=""
V56_OPERATION=""
V56_AUTO=0
V56_APP_STATE=NOT_CHECKED
V56_DB_STATE=NOT_CHECKED
V56_DONE=""
V56_NOT_DONE=""
V56_NEXT=""
V56_REASON=""
V56_HELPER="${CUP_V56_HELPER:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/cup_config.py}"

v56_private_dir() {
  mkdir -p "$PROJECT_DIR/.schema-state/$ENVIRONMENT/logs" || return 1
  chmod 700 "$PROJECT_DIR/.schema-state" "$PROJECT_DIR/.schema-state/$ENVIRONMENT" "$PROJECT_DIR/.schema-state/$ENVIRONMENT/logs" || return 1
}

v56_compose() {
  local file candidate
  local -a args=() files=()
  if [ -n "${COMPOSE_FILE:-}" ]; then
    IFS="${COMPOSE_PATH_SEPARATOR:-:}" read -r -a files <<< "$COMPOSE_FILE"
  else
    for candidate in compose.yaml compose.yml docker-compose.yml docker-compose.yaml; do
      if [ -f "$PROJECT_DIR/$candidate" ]; then files=("$PROJECT_DIR/$candidate"); break; fi
    done
  fi
  [ "${#files[@]}" -gt 0 ] || return 2
  for file in "${files[@]}"; do args+=(-f "$file"); done
  docker compose --project-directory "$PROJECT_DIR" "${args[@]}" "$@"
}

schema_compose() (
  schema_environment diagnose || return 2
  v56_compose "$@"
)

v56_sanitize() { "${CUP_HOST_PYTHON:-python3}" "$V56_HELPER" sanitize; }

v56_build_scoped() (
  schema_environment diagnose || return 2
  local log="$PROJECT_DIR/.schema-state/$ENVIRONMENT/logs/tool-build.log"
  local -a codes
  umask 077
  v56_compose build api 2>&1 | v56_sanitize > "$log"
  codes=("${PIPESTATUS[@]}")
  [ "${codes[1]}" -eq 0 ] || return 1
  return "${codes[0]}"
)

v56_build_context_guard() {
  schema_compose config --format json | "${CUP_HOST_PYTHON:-python3}" -c '
import json,os,sys
from pathlib import Path
c=json.load(sys.stdin);build=c["services"]["api"].get("build")
if build:
 context=Path(build["context"] if isinstance(build,dict) else build).resolve()
 private=[Path(os.environ[k]).resolve() for k in ("CUP_SCHEMA_DB_ENV_FILE","CUP_SCHEMA_ADMIN_ENV_FILE","CUP_SCHEMA_RESTORE_ENV_FILE") if os.environ.get(k)]
 private.append(Path(sys.argv[1]).resolve())
 assert not any(p.is_relative_to(context) for p in private),"private_files_inside_build_context"
' "$PROJECT_DIR/.schema-state"
}

v56_image_version_check() {
  MSYS_NO_PATHCONV=1 docker run --rm --read-only --network none --entrypoint python "$V56_IMAGE" -c '
import hashlib,importlib.metadata,json,pathlib,re
root=pathlib.Path("/app");raw=(root/"requirements.txt").read_bytes().replace(b"\r\n",b"\n")
pins={re.split(r"\[",line.split("==")[0])[0]:line.split("==")[1] for line in raw.decode().splitlines() if "==" in line}
assert all(importlib.metadata.version(name)==version for name,version in pins.items())
print(json.dumps({"app":hashlib.sha256((root/"app.py").read_bytes().replace(b"\r\n",b"\n")).hexdigest(),"requirements":hashlib.sha256(raw).hexdigest()}))
' | "${CUP_HOST_PYTHON:-python3}" -c '
import hashlib,json,pathlib,sys
c=json.load(sys.stdin);root=pathlib.Path(sys.argv[1])
for key,name in (("app","app.py"),("requirements","requirements.txt")):
 assert c[key]==hashlib.sha256((root/name).read_bytes().replace(b"\r\n",b"\n")).hexdigest()
' "$PROJECT_DIR/backend"
}

v56_prepare_tool() {
  local fingerprint tag current
  fingerprint="$("${CUP_HOST_PYTHON:-python3}" "$V56_HELPER" fingerprint "$PROJECT_DIR/backend")" || return 1
  if [ -n "$V56_IMAGE" ] && [ "$fingerprint" = "$V56_FINGERPRINT" ]; then
    if ! "${CUP_HOST_PYTHON:-python3}" -c 'import json,sys;assert json.load(open(sys.argv[1]))=={"services":{"api":{"image":sys.argv[2],"pull_policy":"never"}}}' "$V56_OVERRIDE" "$V56_IMAGE";then
      block_operation 'BLOCKED: pinned tool image document changed';return 2
    fi
    return 0
  fi
  if [ -n "$V56_IMAGE" ] && [ "$V56_AUTO" -eq 1 ]; then block_operation 'BLOCKED: application changed; create and approve a new plan'; return 2; fi
  v561_guard schema_compose_guard || return 2
  v561_guard schema_writer_services || return 2
  v56_private_dir || return 1
  v56_build_context_guard > "$PROJECT_DIR/.schema-state/$ENVIRONMENT/logs/build-context-check.log" 2>&1 || { block_operation 'BLOCKED: private credentials/state inside Docker build context';return 2; }
  v56_private_dir || return 1
  echo 'Этап: подготовка проверенного образа инструмента (один раз для неизменного кода).'
  v56_build_scoped || { LAST_ERROR=1; V56_REASON='Сборка инструмента не завершена'; V56_NEXT='Просмотреть журнал tool-build.log; БД не изменялась'; return 1; }
  current="$("${CUP_HOST_PYTHON:-python3}" "$V56_HELPER" fingerprint "$PROJECT_DIR/backend")" || return 1
  [ "$fingerprint" = "$current" ] || { block_operation 'BLOCKED: source changed during build'; return 2; }
  tag="$(schema_compose config --format json | "${CUP_HOST_PYTHON:-python3}" -c 'import json,sys;c=json.load(sys.stdin);print(c["services"]["api"].get("image") or c["name"]+"-api")')" || return 1
  V56_IMAGE="$(docker image inspect --format '{{.Id}}' "$tag")" || return 1
  [[ "$V56_IMAGE" =~ ^sha256:[a-f0-9]{64}$ ]] || return 1
  v56_image_version_check > "$PROJECT_DIR/.schema-state/$ENVIRONMENT/logs/image-check.log" 2>&1 || { block_operation 'BLOCKED: tool image does not match backend/dependencies';return 2; }
  V56_OVERRIDE="$(mktemp "$PROJECT_DIR/.schema-state/$ENVIRONMENT/tool-image.XXXXXX.json")" || return 1
  chmod 600 "$V56_OVERRIDE" || return 1
  "${CUP_HOST_PYTHON:-python3}" - "$V56_OVERRIDE" "$V56_IMAGE" <<'PIN_IMAGE' || return 1
import json,sys
from pathlib import Path
Path(sys.argv[1]).write_text(json.dumps({'services':{'api':{'image':sys.argv[2],'pull_policy':'never'}}}),encoding='utf8')
PIN_IMAGE
  V56_FINGERPRINT="$fingerprint"
}

schema_cli_scoped() (
  local action="$1" entry=schema_control.py profile backend_mount state_mount raw code
  shift
  profile="$(schema_profile)" || return 2
  case "$action" in workflow-*) entry=schema_workflow.py ;; esac
  if [ "$action" = workflow-backup ]; then schema_environment backup > "$V56_LAST_JSON" || return 2; else schema_environment "$action" > "$V56_LAST_JSON" || return 2; fi
  v561_scoped_guard environment_compose_guard || return 2
  v561_scoped_guard schema_writer_services || return 2
  backend_mount="$PROJECT_DIR/backend"; state_mount="$PROJECT_DIR/.schema-state/$ENVIRONMENT"
  if command -v cygpath >/dev/null 2>&1; then backend_mount="$(cygpath -w "$backend_mount")";state_mount="$(cygpath -w "$state_mount")"; fi
  local -a codes
  umask 077
  MSYS_NO_PATHCONV=1 v56_compose -f "$V56_OVERRIDE" run --rm --no-deps --pull never --entrypoint python \
    -v "$backend_mount:/cup-schema-code:ro" -v "$state_mount:/cup-schema-state" \
    -e CUP_SCHEMA_STATE_DIR=/cup-schema-state -e CUP_MAINTENANCE_POLICY=/cup-schema-state/policy.json -e PYTHONDONTWRITEBYTECODE=1 \
    -e ENV_TYPE -e DB_HOST -e DB_PORT -e DB_NAME -e DB_USER -e DB_PASSWORD \
    -e MAINT_ENV_TYPE -e MAINT_DB_HOST -e MAINT_DB_PORT -e MAINT_DB_NAME -e MAINT_DB_USER -e MAINT_DB_PASSWORD \
    -e RESTORE_ENV_TYPE -e RESTORE_DB_HOST -e RESTORE_DB_PORT -e RESTORE_DB_NAME -e RESTORE_DB_USER -e RESTORE_DB_PASSWORD \
    api "/cup-schema-code/$entry" "$action" --profile "$profile" "$@" 2>&1 | v56_sanitize > "$V56_LAST_JSON"
  codes=("${PIPESTATUS[@]}")
  [ "${codes[1]}" -eq 0 ] || return 1
  return "${codes[0]}"
)

v56_value() {
  "${CUP_HOST_PYTHON:-python3}" - "$V56_LAST_JSON" "$1" <<'READ_VALUE'
import json,sys
from pathlib import Path
for line in reversed(Path(sys.argv[1]).read_text(encoding='utf8').splitlines()):
    try:value=json.loads(line)
    except ValueError:continue
    result=value.get(sys.argv[2],'')
    print(json.dumps(result,ensure_ascii=True) if isinstance(result,(list,dict,bool)) else result)
    break
else:raise SystemExit(1)
READ_VALUE
}

schema_cli() {
  local action="$1" code status reason
  shift
  [ "$action" != maintenance-resume ] || action=workflow-resume
  v56_prepare_tool || return $?
  V56_LAST_JSON="$(mktemp "$PROJECT_DIR/.schema-state/$ENVIRONMENT/logs/result.XXXXXX.json")" || return 1
  chmod 600 "$V56_LAST_JSON" || return 1
  if schema_cli_scoped "$action" "$@"; then code=0; else code=$?; fi
  if [ "$code" -eq 0 ]; then
    if ! "${CUP_HOST_PYTHON:-python3}" - "$V56_LAST_JSON" "$action" <<'VALIDATE_RESULT'
import json,sys
from pathlib import Path
for line in reversed(Path(sys.argv[1]).read_text(encoding='utf8').splitlines()):
    try:r=json.loads(line);break
    except ValueError:continue
else:raise SystemExit(1)
assert isinstance(r,dict)
action=sys.argv[2]
if action in ('diagnose','versions'):
    assert all(k in r for k in ('fingerprint','database_id','current_revision','required_revision'))
elif action=='journal':assert isinstance(r.get('events'),list)
else:
    assert r.get('status')=='SUCCESS'
    phases={'workflow-plan':None,'workflow-approve':{'APPROVED','RESUMED'},'workflow-backup':{'BACKED_UP'},
        'workflow-apply':{'VERIFIED','COMPLETE'},'workflow-verify':{'VERIFIED','RESUMED','COMPLETE','CURRENT_NO_PENDING_OPERATION'},
        'workflow-resume':{'RESUMED','COMPLETE','CURRENT_NO_PENDING_OPERATION'},'workflow-complete':{'COMPLETE'}}
    if action in phases and phases[action] is not None:assert r.get('phase') in phases[action]
    if action=='workflow-plan':assert len(r['plan_id'])==64 and r['action'] in ('noop','upgrade','adopt-or-create','resume-services')
    if action=='workflow-backup':assert r.get('validated_restore') is True
    if action=='check':assert isinstance(r.get('revision'),str)
    if action=='maintenance-begin':assert r.get('maintenance')=='FENCED'
VALIDATE_RESULT
    then code=1;V56_REASON='Инструмент не подтвердил результат операции';fi
  fi
  if [ "$code" -eq 2 ]; then
    reason="$(v56_value reason)" || reason=tool_precondition_failed
    block_operation "BLOCKED: $reason"
    case "$reason" in
      existing_fence_without_workflow*) V56_NEXT='Восстановить проверенную операцию через v5.5; не удалять state и не открывать записи вручную' ;;
      plan_expired*|plan_changed*) V56_NEXT='Повторить 19.9: показать актуальный план и подтвердить его заново' ;;
      restore_target_must_be_empty*) V56_NEXT='Указать новую выделенную пустую restore-БД; занятую БД не очищать автоматически' ;;
      *) V56_NEXT='19.1 / 19.4: проверить состояние и подтвердить актуальный план' ;;
    esac
    return 2
  elif [ "$code" -ne 0 ]; then
    reason="$(v56_value reason)" || reason=tool_failed
    V56_REASON="$action: $reason (код $code)"
    LAST_ERROR="$code";V56_NEXT='19.8: журнал; затем диагностика 19.1. Не снимать Maintenance вручную.';return "$code"
  fi
  local label
  case "$action" in
    workflow-plan) label='План сформирован';V56_DB_STATE=PLANNED ;;
    workflow-approve) label='Подтверждение плана принято' ;;
    maintenance-begin) label='Записывающие сервисы остановлены; записи заблокированы';V56_APP_STATE=STOPPED;V56_DB_STATE=FENCED ;;
    workflow-backup) label='Резервная копия и испытательное восстановление проверены';V56_DB_STATE=FENCED_BACKUP_VERIFIED ;;
    workflow-apply) label='Миграция и сохранность данных проверены';V56_DB_STATE=VERIFIED ;;
    workflow-verify|check) label='Состояние схемы проверено';V56_DB_STATE=VERIFIED ;;
    workflow-resume) label='Записи безопасно возобновлены';V56_DB_STATE=VERIFIED_WRITES_RESUMED ;;
    workflow-complete) label='Операция завершена' ;;
    diagnose|versions) label='Диагностика выполнена';V56_DB_STATE="DIAGNOSED: $(v56_value current_revision)" ;;
    migrations) label='Список миграций проверен' ;;
    journal) label='Журнал операций получен' ;;
    *) label="$action" ;;
  esac
  V56_DONE="${V56_DONE:+$V56_DONE; }$label"
  echo "Этап: $label — выполнен."
}

v56_preview() {
  schema_cli workflow-plan || return $?
  V56_PREVIEW_PLAN="$(v56_value plan_id)" || return 1
  V56_PLAN_ACTION="$(v56_value action)" || return 1
  V56_NEEDS_RESUME="$(v56_value needs_resume)" || return 1
  echo "Среда: $(schema_profile); целевая ревизия: $(v56_value revision)"
  "${CUP_HOST_PYTHON:-python3}" - "$V56_LAST_JSON" <<'HUMAN_PLAN'
import json,sys
from pathlib import Path
for line in reversed(Path(sys.argv[1]).read_text(encoding='utf8').splitlines()):
    try:p=json.loads(line);break
    except ValueError:continue
changes=p.get('required_changes',[])
print('Необходимых изменений схемы нет.' if not changes else 'Необходимые изменения:')
for change in changes:
    if change['kind']=='missing_table':print(' - Создать таблицу '+change['table'])
    elif change['kind']=='missing_column':print(' - Добавить столбец '+change['table']+'.'+change['column'])
    else:print(' - Проверить требование '+change['kind'])
print('Рекомендаций: '+str(len(p.get('recommendations',[])))+' (подробности: 19.8)')
HUMAN_PLAN
}

v56_approve() {
  local answer profile
  profile="$(schema_profile)" || return 2
  require_prod_confirmation 'Schema migration / maintenance recovery' || return 1
  read -rp "Подтвердите показанный план: APPROVE $profile: " answer || return 1
  [ "$answer" = "APPROVE $profile" ] || { block_operation 'BLOCKED: explicit environment and plan approval required';return 2; }
  schema_cli workflow-approve --expected-plan "$V56_PREVIEW_PLAN" --confirmation "$answer"
}

v56_health() {
  local expected actual
  expected="$("${CUP_HOST_PYTHON:-python3}" -c 'import hashlib,pathlib,sys;print(hashlib.sha256(pathlib.Path(sys.argv[1]).read_bytes().replace(b"\r\n",b"\n")).hexdigest())' "$PROJECT_DIR/backend/app.py")" || return 1
  actual="$(MSYS_NO_PATHCONV=1 schema_compose exec -T api python -c 'import hashlib,pathlib;print(hashlib.sha256(pathlib.Path("/app/app.py").read_bytes().replace(b"\r\n",b"\n")).hexdigest())' 2>/dev/null)" || actual=UNAVAILABLE
  if [ "$expected" = "$actual" ] && check_site && check_api; then
    V56_APP_STATE=HEALTHY
    local before="$PROJECT_DIR/.schema-state/$ENVIRONMENT/services-before.txt"
    if [ -f "$before" ];then
      [ ! -L "$before" ] || return 1
      "${CUP_HOST_PYTHON:-python3}" -c 'import json,sys;assert json.load(open(sys.argv[1]))["phase"]=="RESUMED"' "$PROJECT_DIR/.schema-state/$ENVIRONMENT/maintenance.json" || return 1
      rm -f -- "$before" || return 1
    fi
    return 0
  fi
  V56_APP_STATE=FAILED
  V56_REASON="Не подтверждена версия backend или HTTP-ответ приложения"
  V56_NOT_DONE="Не подтверждены версия backend или работоспособность API/сайта"
  V56_NEXT='Схема проверена; проверить запуск/версию API и его журнал. Повторить 19.7; не откатывать миграцию автоматически.'
  return 1
}

v56_auto() {
  V56_AUTO=1
  v56_preview || return $?
  if [ "$V56_PLAN_ACTION" = noop ] && [ "$V56_NEEDS_RESUME" = false ]; then
    schema_cli check || return $?
    V56_DB_STATE=VERIFIED
    v56_health || return 1
    V56_DONE='Схема актуальна; приложение проверено'
    V56_NOT_DONE='Остановка, backup и миграция не требовались'
    schema_cli workflow-complete
    return $?
  fi
  v56_approve || return $?
  if [ "$V56_PLAN_ACTION" != noop ] && [ "$V56_PLAN_ACTION" != resume-services ]; then
    schema_maintenance_begin || return $?
    V56_APP_STATE=STOPPED;V56_DB_STATE=FENCED
    V56_NOT_DONE="Backup/restore, миграция и возобновление ещё не завершены"
    schema_cli workflow-backup || return $?
    schema_cli workflow-apply || return $?
  else
    schema_cli workflow-verify || return $?
  fi
  V56_DB_STATE=VERIFIED
  V56_NOT_DONE="Запуск сервисов и проверка приложения ещё не завершены"
  V56_APP_STATE=START_NOT_CONFIRMED
  schema_maintenance_resume || return $?
  V56_APP_STATE=STARTED
  v56_health || return 1
  schema_cli workflow-complete || return $?
  V56_DONE="${V56_DONE:+$V56_DONE; }Записи и сервисы возобновлены; приложение проверено"
  V56_NOT_DONE='Перенос данных между средами не выполнялся'
}

schema_menu() {
  local choice confirmation
  echo '19.1 Диагностика | 19.2 Версии | 19.3 Миграции | 19.4 План'
  echo '19.5 Backup + restore | 19.6 Применить план | 19.7 Проверить и возобновить | 19.8 Журнал'
  echo '19.9 — Автоматическое обновление структуры БД | 0 — Назад'
  choice="${CUP561_SCHEMA_CHOICE:-}"
  [ -n "$choice" ] || { block_operation 'BLOCKED: schema choice required before operation';return 2; }
  case "$choice" in
    0) V56_DONE='Возврат в меню';return 0 ;;
    1|19.1) schema_cli diagnose ;;
    2|19.2) schema_cli versions ;;
    3|19.3) schema_cli migrations ;;
    4|19.4) v56_preview ;;
    5|19.5) v56_preview && v56_approve && schema_maintenance_begin && schema_cli workflow-backup ;;
    6|19.6) v56_preview && v56_approve && schema_cli workflow-apply ;;
    7|19.7) require_prod_confirmation 'Verify and resume';local rc=$?;[ "$rc" -eq 0 ] || return "$rc"
      read -rp 'Проверить сохранность данных и возобновить? Введите RESUME: ' confirmation
      [ "$confirmation" = RESUME ] || { block_operation 'BLOCKED: RESUME confirmation required';return 2; }
      schema_cli workflow-verify || return $?
      if [ "$(v56_value phase)" = CURRENT_NO_PENDING_OPERATION ];then v56_health;else schema_maintenance_resume && v56_health && schema_cli workflow-complete;fi ;;
    8|19.8) v56_view_logs ;;
    9|19.9) v56_auto ;;
    *) block_operation 'BLOCKED: unknown schema operation';return 2 ;;
  esac
}

v56_report() {
  local result="$1"
  echo "RESULT: $result"
  echo "Среда: $ENVIRONMENT"
  echo "Выполнено: ${V56_DONE:-сценарий $V56_OPERATION; подтверждённые действия доступны в журнале}"
  if [ "$result" = SUCCESS ]; then echo "Не выполнено: ${V56_NOT_DONE:-нет незавершённых шагов выбранной операции}";else echo "Не выполнено: ${V56_NOT_DONE:-последующие шаги остановлены}";fi
  echo "Приложение: $V56_APP_STATE | БД: $V56_DB_STATE"
  if [ "$result" != SUCCESS ]; then echo "Причина: ${BLOCKED_MESSAGE:-${V56_REASON:-ошибка операции; подробности в защищённом журнале}}";fi
  echo "Далее: ${V56_NEXT:-продолжить работу; при необходимости 19.1 / 19.8}"
}
success() { v56_report SUCCESS; }
fail() { v56_report FAILED; }
blocked() { v56_report BLOCKED; }

# Final checks are scoped: a diagnostic/backup is not an application restart.
show_final_status() {
  [ "$LAST_ERROR" -eq 0 ] && [ "$LAST_BLOCKED" -eq 0 ] || return 0
  case "$V56_OPERATION" in 1|2|3|4|5|6|9|10|11|14|17)
    schema_cli check || return 1
    V56_DB_STATE=VERIFIED
    v56_health || return 1 ;;
  esac
}

eval "$(declare -f run_case | sed '1s/run_case/v55_run_case/')"
run_case() {
  V56_OPERATION="$1";V56_AUTO=0;V56_APP_STATE=NOT_CHECKED;V56_DB_STATE=NOT_CHECKED
  V56_DONE="";V56_NOT_DONE="";V56_NEXT="";V56_REASON=""
  V56_IMAGE="";V56_FINGERPRINT=""
  case "$1" in 1|2|3|4|5|6|9|10|11|14|17)
    if [ -f "$PROJECT_DIR/.schema-state/$ENVIRONMENT/maintenance.json" ] &&
       ! "${CUP_HOST_PYTHON:-python3}" -c 'import json,sys;assert json.load(open(sys.argv[1]))["phase"]=="RESUMED"' "$PROJECT_DIR/.schema-state/$ENVIRONMENT/maintenance.json" 2>/dev/null;then
      LAST_ERROR=0;LAST_BLOCKED=0;block_operation 'BLOCKED: active maintenance; use 19.7 / 19.9 before other changes';blocked;return 2
    fi ;;
  esac
  v55_run_case "$@"
}

# Quiet command execution keeps raw diagnostic output off the terminal.
run() {
  local log code
  local -a codes
  v56_private_dir || return 1
  log="$(mktemp "$PROJECT_DIR/.schema-state/$ENVIRONMENT/logs/command.XXXXXX.log")" || return 1
  chmod 600 "$log" || return 1
  echo "Этап: выполнение команды ($1)."
  "$@" 2>&1 | v56_sanitize > "$log"
  codes=("${PIPESTATUS[@]}");code="${codes[0]}"
  [ "${codes[1]}" -eq 0 ] || code=1
  if [ "$code" -ne 0 ]; then LAST_ERROR="$code";V56_REASON="Команда $1 завершилась с кодом $code";fi
  return "$code"
}

show_logs() { run docker compose logs --tail 200 nginx api; }

v56_view_logs() {
  local dir="$PROJECT_DIR/.schema-state/$ENVIRONMENT/logs" file choice
  [ -d "$dir" ] || { echo 'Журнал пока пуст';return 0; }
  echo 'Защищённые очищенные отчёты:'
  for file in "$dir"/*.json "$dir"/*.log;do [ ! -f "$file" ] || basename "$file";done
  read -rp 'Имя файла, j — журнал операций, 0 — назад: ' choice || return 1
  case "$choice" in 0) return 0 ;; j) schema_cli journal || return $?;v56_sanitize < "$V56_LAST_JSON" ;;
    *) [[ "$choice" =~ ^[a-zA-Z0-9][a-zA-Z0-9._-]*$ ]] && [ -f "$dir/$choice" ] && [ ! -L "$dir/$choice" ] || { block_operation 'BLOCKED: invalid log name';return 2; }
       v56_sanitize < "$dir/$choice" ;;
  esac
}

main() {
  if [ "${1:-}" = --profile ]; then
    case "${2:-}" in VPS_LAB) set_environment_vars LAB ;; LOCAL_LAB|PROD) set_environment_vars "$2" ;; *) block_operation 'BLOCKED: explicit profile required';blocked;return 2 ;; esac
  else select_environment;fi
  while true; do
    menu
    read -rp 'Выберите сценарий: ' choice || return 0
    [ "$choice" != 0 ] || return 0
    if [ "$choice" = 12 ];then
      local next_profile
      read -rp 'Профиль LOCAL_LAB / VPS_LAB / PROD: ' next_profile || return 0
      exec bash "$(dirname "$V56_HELPER")/cup.sh" "$next_profile"
    fi
    explain "$choice" || continue
    read -rp 'Запустить? y: ' confirm || return 0
    [ "$confirm" = y ] || continue
    run_case "$choice" || :
    pause
  done
}


# v5.6.1: startup, precise reasons and process-owned operational locking.
CUP561_SCRIPTS="${CUP561_SCRIPTS:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
CUP561_ROOT="$(cd "$CUP561_SCRIPTS/.." && pwd)"
CUP561_LOCK_HELPER="$CUP561_SCRIPTS/cup_lock.py"
CUP561_CHILD="";CUP561_CHILD_START="";CUP561_EXECUTOR=0
CUP561_LOCK_RESULT="";CUP561_LOCK_TOKEN="";CUP561_LOCK_PID=""
CUP561_EXPECTED="";CUP561_SIGNAL="";CUP561_MIGRATION_STATE=NOT_STARTED

v561_instance_phase() {
  [ -n "$PROJECT_DIR" ] || return 0
  "$CUP_HOST_PYTHON" "$CUP561_LOCK_HELPER" register --pid "$BASHPID" --env "$ENVIRONMENT" --directory "$PROJECT_DIR" --phase "$1" >/dev/null 2>&1
}

default_python() {
  local candidate
  for candidate in "${CUP_HOST_PYTHON:-python}" python3;do
    if command -v "$candidate" >/dev/null 2>&1 && "$candidate" -c 'import sys;assert sys.version_info >= (3,11)' >/dev/null 2>&1;then CUP_HOST_PYTHON="$candidate";export CUP_HOST_PYTHON;return 0;fi
  done
  return 2
}

v561_clear_environment() {
  local name
  for name in $(compgen -v);do
    case "$name" in ENV_TYPE|DB_*|MAINT_*|RESTORE_*|MIGRATION_*|MYSQL_*|CUP_SCHEMA_*|CUP_LOCAL_*|COMPOSE_FILE|COMPOSE_PATH_SEPARATOR|CUP_V56_PROFILE|CUP_V56_PROJECT) unset "$name" ;; esac
  done
  ENVIRONMENT="";PROJECT_DIR="";V56_IMAGE="";V56_FINGERPRINT=""
}

v561_load_profile() {
  local profile="$1" path settings error code
  v561_clear_environment
  case "$profile" in LOCAL_LAB) ENVIRONMENT=LOCAL_LAB ;; VPS_LAB) ENVIRONMENT=LAB ;; PROD) ENVIRONMENT=PROD ;; *) block_operation 'unknown_profile';return 2 ;; esac
  path="${CUP_V56_CONFIG:-$("$CUP_HOST_PYTHON" "$V56_HELPER" locate "$CUP561_ROOT" --profile "$profile")}" || return 2
  CUP561_EXPECTED="$path"
  error="$(mktemp)" || return 1
  chmod 600 "$error" || return 1
  if settings="$("$CUP_HOST_PYTHON" "$V56_HELPER" config "$path" --profile "$profile" --error-format json 2> "$error")";then
    rm -f -- "$error"
    eval "$settings"
    case "$profile" in VPS_LAB) set_environment_vars LAB ;; *) set_environment_vars "$profile" ;; esac
    CUP561_EXPECTED="";return 0
  fi
  BLOCKED_MESSAGE="$("$CUP_HOST_PYTHON" -c 'import json,sys;r=json.load(open(sys.argv[1]));print(r["reason"])' "$error" 2>/dev/null)" || BLOCKED_MESSAGE=configuration_validation_failed
  CUP561_EXPECTED="$("$CUP_HOST_PYTHON" -c 'import json,sys;r=json.load(open(sys.argv[1]));print(r.get("expected_path") or sys.argv[2])' "$error" "$path" 2>/dev/null)" || CUP561_EXPECTED="$path"
  rm -f -- "$error"
  LAST_ERROR=1;LAST_BLOCKED=1;V56_DONE='Проверка конфигурации';V56_NOT_DONE='Миграция не начата; подключение к БД не выполнялось'
  V56_APP_STATE=NOT_CHECKED;V56_DB_STATE=NOT_CHECKED;V56_NEXT='Настроить указанный файл по docs/CUP_V561_OPERATIONS.md и повторить выбранную операцию'
  v56_report BLOCKED
  return 2
}

select_environment() {
  local choice profile
  echo 'Среда: 1 — VPS LAB; 2 — PROD; 3 — LOCAL LAB; 0 — выход'
  read -rp 'Выберите среду: ' choice || return 2
  case "$choice" in 0) exit 0 ;; 1|VPS_LAB|LAB) profile=VPS_LAB ;; 2|PROD) profile=PROD ;; 3|LOCAL_LAB) profile=LOCAL_LAB ;; *) return 2 ;; esac
  v561_load_profile "$profile"
}

v561_field() {
  "$CUP_HOST_PYTHON" -c 'import json,sys;r=json.load(open(sys.argv[1]));print(r.get(sys.argv[2],""))' "$1" "$2"
}

v561_lock_command() {
  local action="$1" rc
  shift
  v56_private_dir || return 1
  CUP561_LOCK_RESULT="$(mktemp "$PROJECT_DIR/.schema-state/$ENVIRONMENT/logs/lock.XXXXXX.json")" || return 1
  chmod 600 "$CUP561_LOCK_RESULT" || return 1
  if "$CUP_HOST_PYTHON" "$CUP561_LOCK_HELPER" "$action" --path "$LOCK_FILE" "$@" > "$CUP561_LOCK_RESULT";then return 0;else rc=$?;fi
  BLOCKED_MESSAGE="$(v561_field "$CUP561_LOCK_RESULT" reason)" || BLOCKED_MESSAGE=lock_evidence_unavailable
  return "$rc"
}

acquire_lock() {
  CUP561_LOCK_PID="$BASHPID"
  CUP561_LOCK_TOKEN="$("$CUP_HOST_PYTHON" -c 'import secrets;print(secrets.token_hex(24))')" || return 1
  if v561_lock_command acquire --pid "$CUP561_LOCK_PID" --token "$CUP561_LOCK_TOKEN" --env "$ENVIRONMENT" --directory "$PROJECT_DIR";then LOCK_HELD=1;return 0;fi
  LAST_ERROR=1;LAST_BLOCKED=1
  V56_NEXT='L — проверить владельца/детей и состояние lock. Живой старый ЦУП завершает владелец; lock вручную не удалять.'
  return 2
}

cleanup_lock() {
  [ "$LOCK_HELD" -eq 1 ] || return 0
  if v561_lock_command release --pid "$CUP561_LOCK_PID" --token "$CUP561_LOCK_TOKEN";then LOCK_HELD=0;return 0;fi
  LAST_ERROR=1;LAST_BLOCKED=1;V56_NEXT='L — проверить оставшиеся процессы/one-off контейнеры; Maintenance не снимать'
  return 1
}
release_lock() { cleanup_lock; }

v561_on_signal() {
  local name="$1" code="$2"
  trap '' INT TERM
  CUP561_SIGNAL="$name"
  CUP561_MIGRATION_STATE=UNCONFIRMED_SIGNAL
  if [ -n "$CUP561_CHILD" ];then
    if [ -z "$CUP561_CHILD_START" ];then CUP561_CHILD_START="$("$CUP_HOST_PYTHON" "$CUP561_LOCK_HELPER" identity --pid "$CUP561_CHILD" 2>/dev/null)" || CUP561_CHILD_START="";fi
    if [ -n "$CUP561_CHILD_START" ];then "$CUP_HOST_PYTHON" "$CUP561_LOCK_HELPER" stop-tree --pid "$CUP561_CHILD" --expected "$CUP561_CHILD_START" >/dev/null 2>&1 || :;fi
  fi
  if [ "$CUP561_EXECUTOR" -eq 0 ];then
    V56_DONE='Получен сигнал завершения';V56_NOT_DONE='Незавершённые этапы остановлены; MySQL Maintenance не разблокирован'
    V56_APP_STATE=NOT_CHECKED;V56_DB_STATE=NOT_CHECKED;BLOCKED_MESSAGE="terminated_by_$name";V56_NEXT='Проверить L и 19.1; продолжать только через проверенный recovery'
    v56_report FAILED
  fi
  exit "$code"
}
trap 'cleanup_lock || :' EXIT
trap 'v561_on_signal SIGINT 130' INT
trap 'v561_on_signal SIGTERM 143' TERM

v561_lock_menu() {
  local state fingerprint answer
  v561_lock_command status || :
  state="$(v561_field "$CUP561_LOCK_RESULT" state)" || return 2
  echo "Файловая блокировка ЦУП: $state"
  echo "Причина: $(v561_field "$CUP561_LOCK_RESULT" reason)"
  echo "PID: $(v561_field "$CUP561_LOCK_RESULT" pid); среда владельца: $(v561_field "$CUP561_LOCK_RESULT" env)"
  echo "Версия владельца: $(v561_field "$CUP561_LOCK_RESULT" owner_version); запуск UTC: $(v561_field "$CUP561_LOCK_RESULT" start_utc)"
  echo "Дочерние процессы: $(v561_field "$CUP561_LOCK_RESULT" children); one-off контейнеры: $(v561_field "$CUP561_LOCK_RESULT" containers)"
  echo 'Persistent Maintenance и MySQL account locks этой операцией не изменяются.'
  if [ "$state" = CONFIRMED_STALE ];then
    fingerprint="$(v561_field "$CUP561_LOCK_RESULT" fingerprint)" || return 2
    read -rp "Удалить только подтверждённо устаревший файл? RECOVER $ENVIRONMENT: " answer || return 2
    v561_lock_command recover --expected "$fingerprint" --env "$ENVIRONMENT" --directory "$PROJECT_DIR" --confirmation "$answer" || { LAST_BLOCKED=1;v56_report BLOCKED;return 2; }
    V56_DONE='Удалён подтверждённо устаревший lock-файл';V56_APP_STATE=NOT_CHECKED;V56_DB_STATE=NOT_CHECKED;v56_report SUCCESS
  elif [ "$state" != FREE ];then
    echo 'Чужие процессы не завершаются. Закройте старое меню штатно или проверьте его процессы отдельно; при неопределённости удаление запрещено.'
    LAST_BLOCKED=1;V56_NEXT='Проверить владельца, детей и one-off контейнеры; повторить L после их штатного завершения';v56_report BLOCKED;return 2
  fi
}

eval "$(declare -f run_case | sed '1s/run_case/v561_local_run_case/')"
run_case() {
  local rc=0 fd
  V56_OPERATION="$1";CUP561_SCHEMA_CHOICE="";CUP561_MIGRATION_STATE=NOT_STARTED
  if [ "$1" = 19 ];then
    v561_instance_phase SUBMENU_WAIT || return 2
    echo '19.1 Диагностика | 19.2 Версии | 19.3 Миграции | 19.4 План | 19.5 Backup/restore'
    echo '19.6 Применить | 19.7 Проверить/возобновить | 19.8 Журнал | 19.9 Автоцикл | 0 Назад'
    read -rp 'Операция: ' CUP561_SCHEMA_CHOICE || return 2
    [ "$CUP561_SCHEMA_CHOICE" != 0 ] || return 0
    V56_OPERATION="$CUP561_SCHEMA_CHOICE"
  fi
  v561_instance_phase RUNNING || return 2
  exec {fd}<&0
  (
    CUP561_EXECUTOR=1;CUP561_CHILD="";CUP561_CHILD_START="";LOCK_HELD=0
    trap 'cleanup_lock || :' EXIT
    trap 'v561_on_signal SIGINT 130' INT
    trap 'v561_on_signal SIGTERM 143' TERM
    v561_local_run_case "$@"
  ) <&"$fd" &
  CUP561_CHILD=$!
  exec {fd}<&-
  CUP561_CHILD_START="$("$CUP_HOST_PYTHON" "$CUP561_LOCK_HELPER" identity --pid "$CUP561_CHILD" 2>/dev/null)" || CUP561_CHILD_START=""
  if wait "$CUP561_CHILD";then rc=0;else rc=$?;fi
  CUP561_CHILD="";CUP561_CHILD_START=""
  v561_instance_phase MENU_WAIT || :
  return "$rc"
}

v56_report() {
  local result="$1" reason="${BLOCKED_MESSAGE:-${V56_REASON:-не подтверждено выполнение операции}}"
  echo "RESULT: $result"
  case "$ENVIRONMENT" in LAB) echo 'Среда: VPS LAB' ;; LOCAL_LAB) echo 'Среда: LOCAL LAB' ;; *) echo "Среда: ${ENVIRONMENT:-NOT_SELECTED}" ;; esac
  echo "Операция: ${CUP561_SCHEMA_CHOICE:-${V56_OPERATION:-STARTUP}}"
  echo "Выполнено: ${V56_DONE:-завершённые этапы не подтверждены}"
  echo "Не выполнено: ${V56_NOT_DONE:-последующие/не выбранные этапы}"
  if [ "$result" != SUCCESS ];then
    reason="${reason#BLOCKED: }"
    case "$reason" in required_connection_variable_missing:*) reason="Не задан обязательный параметр ${reason#*:}" ;; private_configuration_file_required) reason='отсутствует защищённый файл конфигурации/credentials' ;; launch_json_invalid) reason='повреждён launch.json' ;; owner_only_configuration_permissions_required|private_windows_acl_required) reason='небезопасные права доступа к конфигурации' ;; esac
    echo "Причина: $reason"
  fi
  [ -z "$CUP561_EXPECTED" ] || echo "Ожидаемый файл: $CUP561_EXPECTED"
  case "$CUP561_MIGRATION_STATE" in
    NOT_STARTED) echo 'Миграция: не начата в этой операции' ;;
    NOT_REQUIRED) echo 'Миграция: не требовалась; схема проверена' ;;
    VERIFIED) echo 'Миграция: выполнена и проверена' ;;
    *) echo 'Миграция: завершение не подтверждено; состояние и данные проверить через recovery' ;;
  esac
  echo "Приложение: $V56_APP_STATE"
  echo "БД: $V56_DB_STATE"
  echo "Далее: ${V56_NEXT:-продолжить работу; 19.8 — журнал}"
}

# Preserve exact lower-level messages that would otherwise disappear in subshells.
block_operation() {
  BLOCKED_MESSAGE="$1";LAST_ERROR=1;LAST_BLOCKED=1
  case "$1" in *required_connection_variable_missing:*)
    local field="${1##*:}"
    case "$field" in MAINT_*) CUP561_EXPECTED="${CUP_SCHEMA_ADMIN_ENV_FILE:-}" ;; RESTORE_*) CUP561_EXPECTED="${CUP_SCHEMA_RESTORE_ENV_FILE:-${CUP_SCHEMA_ADMIN_ENV_FILE:-}}" ;; *) CUP561_EXPECTED="${CUP_SCHEMA_DB_ENV_FILE:-}" ;; esac ;;
  esac
  printf '%s\n' "$1" >&2
}

v561_guard() {
  local error code reason
  local -a codes
  error="$(mktemp)" || return 1
  chmod 600 "$error" || return 1
  "$@" 2>&1 | v56_sanitize > "$error"
  codes=("${PIPESTATUS[@]}");code="${codes[0]}"
  [ "${codes[1]}" -eq 0 ] || code=1
  CUP561_GUARD_OUTPUT=""
  if [ "$code" -eq 0 ];then CUP561_GUARD_OUTPUT="$(cat "$error")";rm -f -- "$error";return 0;fi
  reason="$("$CUP_HOST_PYTHON" - "$error" <<'GUARD_REASON'
import json,sys
from pathlib import Path
sys.stdout.reconfigure(encoding='utf8')
lines=Path(sys.argv[1]).read_text(encoding='utf8').splitlines()
for line in reversed(lines):
    try:r=json.loads(line)
    except ValueError:continue
    if isinstance(r,dict) and r.get('reason'):print(r['reason']);break
else:
    candidates=[line for line in lines if any(x in line.upper() for x in ('BLOCKED','ERROR','FAILED','ОШИБКА'))]
    print('\n'.join(candidates or lines))
GUARD_REASON
)"
  if [ -n "$PROJECT_DIR" ] && v56_private_dir;then
    cp -- "$error" "$PROJECT_DIR/.schema-state/$ENVIRONMENT/logs/infrastructure-guard.log" || :
    chmod 600 "$PROJECT_DIR/.schema-state/$ENVIRONMENT/logs/infrastructure-guard.log" || :
  fi
  rm -f -- "$error"
  block_operation "${reason:-инфраструктурная проверка отказала без диагностического сообщения}"
  return "$code"
}

# Scoped preconditions run in a child; carry their precise sanitized reason back
# through the existing result document instead of losing it with child variables.
v561_scoped_guard() {
  v561_guard "$@" && return 0
  printf '%s' "$BLOCKED_MESSAGE" | "$CUP_HOST_PYTHON" -c 'import json,sys;print(json.dumps({"status":"BLOCKED","reason":sys.stdin.read()}))' > "$V56_LAST_JSON"
  return 2
}

eval "$(declare -f schema_cli | sed '1s/schema_cli/v561_original_schema_cli/')"
schema_cli() {
  local code
  case "$1" in workflow-apply) CUP561_MIGRATION_STATE=REQUESTED ;; esac
  if v561_original_schema_cli "$@";then code=0;else code=$?;fi
  if [ "$code" -eq 0 ];then
    case "$1" in
      workflow-apply) case "$(v56_value changed)" in
        true) CUP561_MIGRATION_STATE=VERIFIED ;;
        false) CUP561_MIGRATION_STATE=NOT_REQUIRED ;;
        *) CUP561_MIGRATION_STATE=UNCONFIRMED_RESULT;LAST_ERROR=1;V56_REASON='workflow-apply: результат изменения схемы не подтверждён';return 1 ;;
      esac ;;
      workflow-plan) [ "$(v56_value action)" != noop ] || CUP561_MIGRATION_STATE=NOT_REQUIRED ;;
    esac
  fi
  return "$code"
}

eval "$(declare -f v56_approve | sed '1s/v56_approve/v561_original_approve/')"
v56_approve() {
  local code
  v561_instance_phase WAITING_CONFIRM || return 2
  if v561_original_approve;then code=0;else code=$?;fi
  v561_instance_phase RUNNING || return 2
  return "$code"
}

main() {
  default_python || { echo 'RESULT: BLOCKED; Python 3.11+ required';return 2; }
  V56_HELPER="$CUP561_SCRIPTS/cup_config.py"
  if [ "${1:-}" = --profile ];then v561_load_profile "${2:-}" || return $?;else select_environment || return $?;fi
  while true;do
    v561_instance_phase MENU_WAIT || { block_operation 'instance_registry_unavailable';v56_report BLOCKED;return 2; }
    menu;echo 'L) Проверка файловой блокировки / подтверждённый stale recovery'
    read -rp 'Выберите сценарий: ' choice || return 0
    case "$choice" in 0) return 0 ;; 12) select_environment || return $?;continue ;; L|l) v561_lock_menu || :;pause;continue ;; esac
    if [ "$choice" != 19 ];then
      explain "$choice" || continue
      read -rp 'Запустить? y: ' confirm || return 0
      [ "$confirm" = y ] || continue
    fi
    run_case "$choice" || :
    pause
  done
}

main "$@"
