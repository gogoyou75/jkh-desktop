#!/usr/bin/env bash

# ============================================================
# OPS v2 - PROTECTED DEPLOY SYSTEM (PAPAZKH)
# Safety Layer over JKH v5 Menu
# ============================================================

set -e

LOCK_FILE="/tmp/ops_v2.lock"

LAB_PATH="/root/jkh-lab"
PROD_PATH="/root/jkh"

# ----------------------------
# UI HELPERS
# ----------------------------

line() {
  echo "============================================================"
}

info() {
  echo "ℹ $1"
}

warn() {
  echo "⚠ $1"
}

ok() {
  echo "✔ $1"
}

fail() {
  echo "❌ $1"
}

# ----------------------------
# LOCK SYSTEM
# ----------------------------

check_lock() {
  if [ -f "$LOCK_FILE" ]; then
    fail "OPS already running"
    exit 1
  fi
  touch "$LOCK_FILE"
}

unlock() {
  rm -f "$LOCK_FILE"
}

trap unlock EXIT

# ----------------------------
# DASHBOARD
# ----------------------------

dashboard() {
  line
  echo "OPS v2 DASHBOARD"
  line

  echo "LAB:"
  docker ps | grep jkh-lab || echo "none"

  echo ""
  echo "PROD:"
  docker ps | grep jkh_ || echo "none"

  line
}

# ----------------------------
# CONFIRMATION
# ----------------------------

confirm() {
  echo "⚠ $1"
  read -rp "Type YES: " a
  [ "$a" = "YES" ] || exit 1
}

# ----------------------------
# HEALTH CHECK
# ----------------------------

health() {
  local env=$1

  if [ "$env" = "lab" ]; then
    code=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8080 || true)
  else
    code=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1/ || true)
  fi

  echo "HTTP: $code"

  if [ "$code" != "200" ] && [ "$code" != "401" ] && [ "$code" != "302" ]; then
    fail "HEALTH FAILED"
    return 1
  fi

  ok "HEALTH OK"
}

# ----------------------------
# ROLLBACK
# ----------------------------

rollback() {
  local env=$1

  warn "ROLLBACK $env"

  if [ "$env" = "lab" ]; then
    cd "$LAB_PATH"
  else
    cd "$PROD_PATH"
  fi

  git reset --hard HEAD~1 || true
  docker compose up -d --build || true

  ok "ROLLBACK DONE"
}

# ----------------------------
# DEPLOY
# ----------------------------

deploy() {
  local env=$1

  check_lock
  confirm "DEPLOY $env"
  dashboard

  if [ "$env" = "lab" ]; then
    cd "$LAB_PATH"
  else
    cd "$PROD_PATH"
  fi

  docker compose down
  docker compose up -d --build

  sleep 3

  if health "$env"; then
    ok "DEPLOY OK"
  else
    fail "DEPLOY FAILED"
    rollback "$env"
  fi

  dashboard
}

# ----------------------------
# MENU
# ----------------------------

menu() {
  clear
  line
  echo "OPS v2 SYSTEM"
  line
  echo "1) Deploy LAB"
  echo "2) Deploy PROD"
  echo "3) Dashboard"
  echo "4) Exit"
  line
}

main() {
  while true; do
    menu
    read -rp "Select: " c

    case $c in
      1) deploy lab ;;
      2) deploy prod ;;
      3) dashboard ;;
      4) exit 0 ;;
      *) echo "invalid" ;;
    esac

    read -rp "Enter..."
  done
}

main
