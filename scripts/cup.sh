#!/usr/bin/env bash
set -u
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)" || exit 2
profile="${1:-}"
case "$profile" in LOCAL_LAB) environment=LOCAL_LAB ;; VPS_LAB) environment=LAB ;; PROD) environment=PROD ;; *) echo 'RESULT: BLOCKED; usage: bash scripts/cup.sh LOCAL_LAB|VPS_LAB|PROD'; exit 2 ;; esac
python=""
for candidate in "${CUP_HOST_PYTHON:-python}" python3; do
  if command -v "$candidate" >/dev/null 2>&1 && "$candidate" -c 'import sys;assert sys.version_info >= (3,11)' >/dev/null 2>&1; then python="$candidate";break;fi
done
[ -n "$python" ] || { echo 'RESULT: BLOCKED; Python 3.11+ is required; no installation or security change was attempted';exit 2; }
config="${CUP_V56_CONFIG:-$root/.schema-state/$environment/launch.json}"
settings="$("$python" "$root/scripts/cup_config.py" config "$config" --profile "$profile")" || {
  printf 'RESULT: BLOCKED\nСреда: %s\nВыполнено: проверка конфигурации\nНе выполнено: подключение к БД и операции\nПриложение: NOT_CHECKED | БД: NOT_CHECKED\nДалее: настройте защищённый launch.json по docs/CUP_V56_AUTOMATION.md\n' "$profile"
  exit 2
}
eval "$settings"
export CUP_HOST_PYTHON="$python"
exec bash "$root/scripts/jkh_server_menu_v5_6.sh" --profile "$profile"
