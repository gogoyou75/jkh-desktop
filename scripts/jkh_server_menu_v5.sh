#!/usr/bin/env bash

set -u

ENVIRONMENT=""
PROJECT_DIR=""
SITE_CHECK=""
BACKUP_DIR="/root/jkh-backups"

print_separator() {
  printf '\n%s\n' "============================================================"
}

pause_menu() {
  printf '\n'
  read -r -p "Нажмите Enter, чтобы вернуться в меню..." _
}

require_prod_confirmation() {
  local action="$1"
  local answer

  if [[ "$ENVIRONMENT" != "PROD" ]]; then
    return 0
  fi

  printf '\nВНИМАНИЕ: PROD. Действие: %s\n' "$action"
  read -r -p "Для продолжения введите YES_PROD: " answer
  if [[ "$answer" != "YES_PROD" ]]; then
    echo "Операция отменена."
    return 1
  fi
}

select_environment() {
  while true; do
    print_separator
    echo "Выберите среду:"
    echo "1) LAB  (/root/jkh-lab, http://127.0.0.1:8080)"
    echo "2) PROD (/root/jkh,     http://127.0.0.1/)"
    echo "0) Выход"
    read -r -p "> " choice

    case "$choice" in
      1)
        ENVIRONMENT="LAB"
        PROJECT_DIR="/root/jkh-lab"
        SITE_CHECK="http://127.0.0.1:8080"
        ;;
      2)
        ENVIRONMENT="PROD"
        PROJECT_DIR="/root/jkh"
        SITE_CHECK="http://127.0.0.1/"
        ;;
      0)
        exit 0
        ;;
      *)
        echo "Неизвестный пункт."
        continue
        ;;
    esac

    if [[ ! -d "$PROJECT_DIR/.git" ]]; then
      echo "Ошибка: $PROJECT_DIR не является Git-репозиторием."
      ENVIRONMENT=""
      continue
    fi

    cd "$PROJECT_DIR" || {
      echo "Не удалось перейти в $PROJECT_DIR."
      ENVIRONMENT=""
      continue
    }
    break
  done
}

warn_worktree_changes() {
  local changes
  changes="$(git status --porcelain)"
  if [[ -n "$changes" ]]; then
    printf '\nВНИМАНИЕ: найдены modified/untracked файлы:\n%s\n' "$changes"
    echo "Скрипт не выполняет git reset --hard и git clean."
  fi
}

confirm_worktree_changes() {
  local answer

  warn_worktree_changes
  if [[ -z "$(git status --porcelain)" ]]; then
    return 0
  fi

  read -r -p "Продолжить, сохранив локальные файлы? [y/N]: " answer
  [[ "$answer" =~ ^[Yy]$ ]] || {
    echo "Операция отменена."
    return 1
  }
}

backup_mysql() {
  local timestamp backup_file

  [[ "$ENVIRONMENT" == "PROD" ]] || return 0

  timestamp="$(date +%Y%m%d_%H%M%S)"
  backup_file="$BACKUP_DIR/jkh_mysql_${timestamp}.sql"
  mkdir -p "$BACKUP_DIR" || {
    echo "Не удалось создать каталог backup: $BACKUP_DIR"
    return 1
  }

  echo "Создаю backup MySQL: $backup_file"
  if docker compose exec -T mysql sh -c \
    'exec mysqldump -uroot -p"$MYSQL_ROOT_PASSWORD" --single-transaction --routines --triggers "$MYSQL_DATABASE"' \
    > "$backup_file"; then
    if [[ -s "$backup_file" ]]; then
      echo "Backup MySQL создан."
      return 0
    fi
  fi

  echo "Ошибка backup MySQL. Deploy остановлен."
  if [[ -e "$backup_file" ]]; then
    mv "$backup_file" "${backup_file}.failed"
    echo "Неудачный backup сохранён: ${backup_file}.failed"
  fi
  return 1
}

prepare_deploy() {
  local description="$1"

  require_prod_confirmation "deploy: $description" || return 1
  confirm_worktree_changes || return 1
  backup_mysql || return 1
}

docker_build_up() {
  require_prod_confirmation "docker build" || return 1
  docker compose up -d --build
}

switch_to_branch() {
  local branch="$1"

  if git show-ref --verify --quiet "refs/heads/$branch"; then
    git switch "$branch"
  elif git show-ref --verify --quiet "refs/remotes/origin/$branch"; then
    git switch --track "origin/$branch"
  else
    echo "Ветка origin/$branch не найдена."
    return 1
  fi
}

pull_current_branch() {
  local branch="$1"

  git pull --ff-only origin "$branch"
}

deploy_main() {
  prepare_deploy "обновление main" || return
  git fetch origin || return
  switch_to_branch "main" || return
  pull_current_branch "main" || return
  docker_build_up || return
  docker compose ps
}

deploy_test_branch() {
  local with_build="$1"
  local branch

  read -r -p "Имя тестовой ветки: " branch
  if [[ -z "$branch" ]]; then
    echo "Имя ветки не задано."
    return
  fi

  if [[ "$with_build" == "yes" ]]; then
    prepare_deploy "тестовая ветка $branch с build" || return
  else
    prepare_deploy "тестовая ветка $branch без build" || return
  fi

  git fetch origin || return
  switch_to_branch "$branch" || return
  pull_current_branch "$branch" || return

  if [[ "$with_build" == "yes" ]]; then
    docker_build_up || return
  else
    docker compose up -d || return
  fi
  docker compose ps
}

restart_services() {
  docker compose restart
  docker compose ps
}

show_logs() {
  local service

  read -r -p "Сервис (пусто = все сервисы): " service
  if [[ -n "$service" ]]; then
    docker compose logs --tail=200 "$service"
  else
    docker compose logs --tail=200
  fi
}

run_checks() {
  echo "Проверка конфигурации Docker Compose:"
  docker compose config --quiet
  echo "Проверка контейнеров:"
  docker compose ps
  echo "Проверка сайта:"
  curl -fsS -o /dev/null \
    -w "GET $SITE_CHECK -> HTTP %{http_code}, время %{time_total}s\n" \
    "$SITE_CHECK" || echo "Сайт недоступен: $SITE_CHECK"
}

cherry_pick_commit() {
  local hash answer

  git fetch origin || return
  read -r -p "Хеш коммита: " hash
  if [[ -z "$hash" ]]; then
    echo "Хеш не задан."
    return
  fi

  if ! git show --stat --oneline --decorate "$hash"; then
    echo "Коммит не найден."
    return
  fi

  read -r -p "Применить этот коммит? [y/N]: " answer
  [[ "$answer" =~ ^[Yy]$ ]] || {
    echo "Операция отменена."
    return
  }

  require_prod_confirmation "cherry-pick $hash" || return
  confirm_worktree_changes || return
  backup_mysql || return
  git cherry-pick "$hash" || {
    echo "Cherry-pick остановлен. Исправьте конфликты вручную."
    echo "Отмена конфликта: git cherry-pick --abort"
    return
  }
  docker_build_up || return
  docker compose ps
}

show_operation_summary() {
  print_separator
  echo "Итоговое состояние:"
  echo
  echo "pwd:"
  pwd
  echo
  echo "Текущая ветка:"
  git branch --show-current
  echo
  echo "git status -sb:"
  git status -sb
  echo
  echo "Последние 3 коммита:"
  git log -3 --oneline --decorate
  echo
  echo "docker compose ps:"
  docker compose ps
  echo
  echo "curl-проверка сайта:"
  curl -fsS -o /dev/null \
    -w "GET $SITE_CHECK -> HTTP %{http_code}, время %{time_total}s\n" \
    "$SITE_CHECK" || echo "Сайт недоступен: $SITE_CHECK"
}

main_menu() {
  local choice

  while true; do
    print_separator
    printf "JKH server menu v5 | %s | %s\n" "$ENVIRONMENT" "$PROJECT_DIR"
    echo "1) Обычное обновление main (с build)"
    echo "2) Тестовая ветка с build"
    echo "3) Тестовая ветка без build"
    echo "4) Restart контейнеров"
    echo "5) Логи"
    echo "6) Проверки"
    echo "7) Применить один коммит cherry-pick"
    echo "8) Сменить среду"
    echo "0) Выход"
    read -r -p "> " choice

    case "$choice" in
      1) deploy_main ;;
      2) deploy_test_branch "yes" ;;
      3) deploy_test_branch "no" ;;
      4) restart_services ;;
      5) show_logs ;;
      6) run_checks ;;
      7) cherry_pick_commit ;;
      8)
        select_environment
        continue
        ;;
      0)
        exit 0
        ;;
      *)
        echo "Неизвестный пункт."
        pause_menu
        continue
        ;;
    esac

    show_operation_summary
    pause_menu
  done
}

select_environment
main_menu
