#!/usr/bin/env bash
set -euo pipefail
menu="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/jkh_server_menu_v5_5.sh"
fixture="$(mktemp -d)"
source <(sed '$d' "$menu")
[[ "$VERSION" == v5.5 ]]
LOCK_FILE="$fixture/menu.lock"
LOCK_HELD=0
# Existing cases isolate routing/locks. Environment preparation is tested below
# with the real implementation and child-process exports.
eval "$(declare -f schema_environment | sed '1s/schema_environment/schema_environment_real/')"
schema_environment() { return 0; }

(
  set_environment_vars LAB
  [[ "$PROJECT_DIR" == /root/jkh-lab && "$MYSQL_CONTAINER" == jkh_lab_mysql ]]
  [[ "$(schema_profile)" == VPS_LAB ]]
  set_environment_vars PROD
  [[ "$PROJECT_DIR" == /root/jkh && "$(schema_profile)" == PROD ]]
  unset CUP_LOCAL_PROJECT_DIR CUP_LOCAL_MYSQL_CONTAINER CUP_LOCAL_SITE_CHECK
  if set_environment_vars LOCAL_LAB; then exit 1; fi
  CUP_LOCAL_PROJECT_DIR="$fixture/local"
  CUP_LOCAL_MYSQL_CONTAINER=cup_test_mysql
  CUP_LOCAL_SITE_CHECK=http://127.0.0.1:18080
  set_environment_vars LOCAL_LAB
  environment_guard
  [[ "$(schema_profile)" == LOCAL_LAB && "$PROJECT_DIR" != /root/* ]]
  PROJECT_DIR=/root/jkh
  if environment_guard; then exit 1; fi
)
echo 'PASS: three explicit profiles preserve LAB/PROD and reject LOCAL fallback/server paths'

(
  ENVIRONMENT=LOCAL_LAB
  PROJECT_DIR="$fixture/local"
  MYSQL_CONTAINER=cup_test_mysql
  mkdir -p "$PROJECT_DIR"
  CUP_HOST_PYTHON="${CUP_HOST_PYTHON:-python}"
  cat > "$fixture/compose.json" <<'COMPOSE'
{"name":"cup_test","services":{"api":{"environment":{"ENV_TYPE":"LOCAL_LAB","DB_HOST":"mysql","DB_NAME":"jkh_local_lab","DB_USER":"jkh_local"}},"mysql":{"container_name":"cup_test_mysql","volumes":[]}},"volumes":{"mysql_data":{"name":"cup_test_mysql_data"}}}
COMPOSE
  docker() { if [[ "$1" == context ]]; then printf '%s\n' unix:///cup-fixture.sock; else cat "$fixture/compose.json"; fi; }
  local_infra_guard
  "$CUP_HOST_PYTHON" - "$fixture/compose.json" <<'INVALID'
import json,sys
from pathlib import Path
p=Path(sys.argv[1]);d=json.loads(p.read_text());d['services']['api']['environment']['ENV_TYPE']='PROD';p.write_text(json.dumps(d))
INVALID
  if local_infra_guard; then exit 1; fi
)
echo 'PASS: LOCAL compose inspection rejects cross-environment configuration'

(
  ENVIRONMENT=LAB
  environment_compose_guard() { return 0; }
  schema_cli() { return 2; }
  docker() { printf 'unexpected\n' > "$fixture/docker-called"; }
  if compose_restart; then exit 1; fi
  if compose_up_build; then exit 1; fi
  if run_basic_checks; then exit 1; fi
  if full_stage_verification; then exit 1; fi
  [[ ! -e "$fixture/docker-called" && "$LAST_BLOCKED" -eq 1 ]]
)
echo 'PASS: incompatible schema blocks Docker restart and build without false SUCCESS'

(
  ENVIRONMENT=LAB
  SELECTED_BRANCH=fixture-branch
  run() { return 0; }
  schema_target_gate() { return 2; }
  v541_run_git_preserving_infra() { printf 'unexpected\n' > "$fixture/git-called"; }
  for operation in checkout reset pull; do
    if run_git_preserving_infra fixture git "$operation" main; then exit 1; fi
  done
  if run_git_preserving_infra fixture lab_checkout_test_branch_preserving_infra; then exit 1; fi
  [[ ! -e "$fixture/git-called" ]]
)
echo 'PASS: target incompatibility blocks all Git update/reset/LAB routes before mutation'

(
  SCHEMA_PINNED_TARGET=""
  run() { return 0; }
  schema_target_gate() { SCHEMA_PINNED_TARGET=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa; }
  v541_run_git_preserving_infra() { shift; printf '%s\n' "$*" > "$fixture/pinned"; }
  run_git_preserving_infra fixture git pull --ff-only origin main
  [[ "$(cat "$fixture/pinned")" == 'git merge --ff-only aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' ]]
  run_git_preserving_infra fixture git reset --hard HEAD~1
  [[ "$(cat "$fixture/pinned")" == 'git reset --hard aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' ]]
)
echo 'PASS: update and rollback use the exact schema-validated SHA'

(
  real_backend="$(dirname "$menu")/../backend"
  ENVIRONMENT=LOCAL_LAB
  PROJECT_DIR="$fixture/target-project"
  mkdir -p "$PROJECT_DIR"
  git() {
    if [[ "$1" == rev-parse ]]; then printf '%s\n' aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
    elif [[ "$1" == show ]]; then
      local rel="${2#*:backend/}"
      cat "$real_backend/$rel"
    else return 1; fi
  }
  schema_cli() { [[ "$1" == check && "$2" == --target-package ]]; }
  schema_target_gate fixture-target
  [[ "$SCHEMA_PINNED_TARGET" == aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa ]]
  [[ "$(find "$PROJECT_DIR/.schema-state" -name schema_contract.json | wc -l)" -eq 1 ]]
)
echo 'PASS: target gate exports data-only contract/snapshot/model files without a checkout'

(
  ENVIRONMENT=LOCAL_LAB
  pause() { :; }
  require_prod_confirmation() { return 0; }
  schema_cli() { printf '%s\n' "$1" >> "$fixture/submenu-actions"; }
  schema_maintenance_begin() { printf '%s\n' maintenance-begin >> "$fixture/submenu-actions"; }
  schema_maintenance_resume() { printf '%s\n' maintenance-resume >> "$fixture/submenu-actions"; }
  PROJECT_DIR="$fixture/menu-project"
  schema_menu <<< $'19.1\n19.2\n19.3\n19.4\n19.5\nRESTORE_TEST_DB\n19.6\nfixture-backup\nAPPLY LOCAL_LAB fixture-plan\n19.7\nRESUME\n19.8\n0'
  [[ "$(tr '\n' ' ' < "$fixture/submenu-actions")" == 'diagnose versions migrations plan maintenance-begin backup apply maintenance-resume journal ' ]]
)
echo 'PASS: all eight schema submenu routes preserve explicit backup/apply confirmations'

(
  ENVIRONMENT=LOCAL_LAB
  schema_menu() { return 73; }
  go_project() { return 0; }
  show_final_status() { :; }
  if run_case 19 > "$fixture/status.log"; then exit 1; fi
  grep -q '^ERROR:' "$fixture/status.log"
  ! grep -q '^SUCCESS:' "$fixture/status.log"
  [[ "$LAST_ERROR" -eq 73 && ! -e "$LOCK_FILE" ]]
)
echo 'PASS: new menu route propagates failures and releases its owned lock'

(
  ENVIRONMENT=LOCAL_LAB
  for report in lab_prod_readiness_preflight lab_prod_deploy_wizard check_lab_prod_isolation; do
    if "$report"; then exit 1; fi
  done
)
echo 'PASS: LOCAL profile cannot enter VPS cross-environment reports'

(
  ENVIRONMENT=LOCAL_LAB
  PROJECT_DIR="$fixture/cli-status"
  schema_writer_services() { return 0; }
  mkdir -p "$PROJECT_DIR"
  environment_compose_guard() { return 0; }
  go_project() { return 0; }
  show_final_status() { :; }
  docker() { return "$fake_rc"; }
  for fake_rc in 2 1; do
    if run_case 19 <<< '19.1' > "$fixture/cli-status.log"; then exit 1; fi
    if [[ "$fake_rc" == 2 ]]; then
      grep -q '^BLOCKED:' "$fixture/cli-status.log"
    else
      grep -q '^ERROR:' "$fixture/cli-status.log"
    fi
    ! grep -q '^SUCCESS:' "$fixture/cli-status.log"
    [[ ! -e "$LOCK_FILE" ]]
  done
)
echo 'PASS: schema-tool BLOCKED and ERROR exit codes retain distinct menu results'


(
  ENVIRONMENT=LOCAL_LAB
  PROJECT_DIR="$fixture/service-policy"
  mkdir -p "$PROJECT_DIR/.schema-state/LOCAL_LAB"
  printf '%s' '{"services":{"api":{},"worker":{},"mysql":{},"nginx":{}}}' > "$fixture/services-config.json"
  printf '%s' '{"services":["api"]}' > "$PROJECT_DIR/.schema-state/LOCAL_LAB/policy.json"
  docker() { cat "$fixture/services-config.json"; }
  if schema_writer_services; then exit 1; fi
  printf '%s' '{"services":["api","worker"]}' > "$PROJECT_DIR/.schema-state/LOCAL_LAB/policy.json"
  [[ "$(schema_writer_services)" == 'api worker' ]]
  for key in MYSQL_ROOT_PASSWORD MYSQL_ROOT_PASSWORD_FILE MAINT_DB_PASSWORD MIGRATION_DB_PASSWORD RESTORE_DB_PASSWORD; do
    printf '{"services":{"api":{"environment":{"%s":"synthetic_only"}},"worker":{},"mysql":{},"nginx":{}}}' "$key" > "$fixture/services-config.json"
    if schema_writer_services; then exit 1; fi
  done
)
echo 'PASS: undeclared Compose writer services block maintenance'
echo 'PASS: persistent API rejects application-external Maintenance Migration Restore and root credentials'

(
  ENVIRONMENT=LOCAL_LAB
  PROJECT_DIR="$fixture/service-stop"
  environment_compose_guard() { return 0; }
  schema_writer_services() { printf '%s\n' 'api worker'; }
  schema_cli() { printf '%s\n' "$1" >> "$fixture/service-actions"; }
  docker() {
    case "$*" in
      'compose ps --status running --services api worker') printf '%s\n' api ;;
      'compose stop --timeout 30 api worker') printf '%s\n' stop >> "$fixture/service-actions" ;;
      'compose ps --status running -q api worker') return 0 ;;
      *) return 99 ;;
    esac
  }
  schema_maintenance_begin
  [[ "$(tr '\n' ' ' < "$fixture/service-actions")" == 'stop maintenance-begin ' ]]
  [[ "$(cat "$PROJECT_DIR/.schema-state/LOCAL_LAB/services-before.txt")" == api ]]
  docker() { return 71; }
  if schema_maintenance_begin; then exit 1; fi
)
echo 'PASS: all declared writers stop before DB fencing; stop failure blocks continuation'

(
  ENVIRONMENT=LOCAL_LAB
  PROJECT_DIR="$fixture/still-running"
  environment_compose_guard() { return 0; }
  schema_writer_services() { echo api; }
  schema_cli() { touch "$fixture/unexpected-fence"; }
  docker() { [[ "$*" != 'compose stop --timeout 30 api' ]] && echo running || :; }
  if schema_maintenance_begin; then exit 1; fi
  [[ ! -f "$fixture/unexpected-fence" && "$LAST_BLOCKED" -eq 1 ]]
)
echo 'PASS: writers remaining alive block backup/migration admission'

(
  ENVIRONMENT=LOCAL_LAB
  PROJECT_DIR="$fixture/resume"
  mkdir -p "$PROJECT_DIR/.schema-state/LOCAL_LAB"
  printf '%s\n' api > "$PROJECT_DIR/.schema-state/LOCAL_LAB/services-before.txt"
  schema_writer_services() { echo 'api worker'; }
  schema_cli() { return 2; }
  docker() { touch "$fixture/unexpected-start"; }
  if schema_maintenance_resume; then exit 1; fi
  [[ ! -e "$fixture/unexpected-start" && -f "$PROJECT_DIR/.schema-state/LOCAL_LAB/services-before.txt" ]]
  schema_cli() { echo "$1" >> "$fixture/resume-order"; }
  docker() { echo "$*" >> "$fixture/resume-order"; }
  schema_maintenance_resume
  [[ "$(tr '\n' ' ' < "$fixture/resume-order")" == 'maintenance-resume compose start api ' ]]
  [[ ! -f "$PROJECT_DIR/.schema-state/LOCAL_LAB/services-before.txt" ]]
)
echo 'PASS: failed schema verification never starts writers; success restores only prior services'

! grep -q 'WRITERS_STOPPED\|--maintenance-confirmed' "$menu"
echo 'PASS: obsolete maintenance acknowledgement cannot be used by the menu'


(
  ENVIRONMENT=LOCAL_LAB
  PROJECT_DIR="$fixture/repeat-resume"
  mkdir -p "$PROJECT_DIR/.schema-state/LOCAL_LAB"
  printf '%s' '{"phase":"RESUMED"}' > "$PROJECT_DIR/.schema-state/LOCAL_LAB/maintenance.json"
  schema_writer_services() { echo api; }
  schema_cli() { echo "$1" > "$fixture/repeat-verified"; }
  docker() { touch "$fixture/repeat-unexpected-start"; }
  schema_maintenance_resume
  [[ "$(cat "$fixture/repeat-verified")" == maintenance-resume && ! -e "$fixture/repeat-unexpected-start" ]]
  rm -f "$fixture/repeat-verified"
  printf '%s' '{"phase":"FENCED"}' > "$PROJECT_DIR/.schema-state/LOCAL_LAB/maintenance.json"
  if schema_maintenance_resume; then exit 1; fi
  [[ ! -e "$fixture/repeat-verified" && "$LAST_BLOCKED" -eq 1 ]]
)
echo 'PASS: repeated completed resume re-verifies; lost active service state prevents unlock'

(
  ENVIRONMENT=LOCAL_LAB
  PROJECT_DIR="$fixture/start-retry"
  mkdir -p "$PROJECT_DIR/.schema-state/LOCAL_LAB"
  printf '%s\n' api > "$PROJECT_DIR/.schema-state/LOCAL_LAB/services-before.txt"
  schema_writer_services() { echo api; }
  schema_cli() { return 0; }
  docker() { return 63; }
  if schema_maintenance_resume; then exit 1; fi
  [[ -f "$PROJECT_DIR/.schema-state/LOCAL_LAB/services-before.txt" ]]
  docker() { [[ "$*" == 'compose start api' ]]; }
  schema_maintenance_resume
  [[ ! -f "$PROJECT_DIR/.schema-state/LOCAL_LAB/services-before.txt" ]]
)
echo 'PASS: service-start failure retains original state for a checked retry'

(
  schema_environment() { schema_environment_real "$@"; }
  ENVIRONMENT=LOCAL_LAB
  PROJECT_DIR="$fixture/env-scope"
  mkdir -p "$PROJECT_DIR"
  CUP_SCHEMA_DB_ENV_FILE="$fixture/schema-db.env"
  CUP_SCHEMA_ADMIN_ENV_FILE="$fixture/schema-admin.env"
  cat > "$CUP_SCHEMA_DB_ENV_FILE" <<'DB_ENV'
ENV_TYPE=LOCAL_LAB
DB_HOST=mysql
DB_PORT=3306
DB_NAME=jkh_local_lab
DB_USER=jkh_local
DB_PASSWORD=synthetic_app_only
DB_ENV
  cat > "$CUP_SCHEMA_ADMIN_ENV_FILE" <<'ADMIN_ENV'
MAINT_ENV_TYPE=LOCAL_LAB
MAINT_DB_HOST=mysql
MAINT_DB_PORT=3306
MAINT_DB_NAME=jkh_local_lab
MAINT_DB_USER=synthetic_maintenance
MAINT_DB_PASSWORD=synthetic_admin_only
RESTORE_ENV_TYPE=LOCAL_LAB
RESTORE_DB_HOST=cup-schema-mysql
RESTORE_DB_PORT=3306
RESTORE_DB_NAME=cup_restore_synthetic
RESTORE_DB_USER=synthetic_restore
RESTORE_DB_PASSWORD=synthetic_restore_only
ADMIN_ENV
  unset DB_PASSWORD MAINT_DB_PASSWORD RESTORE_DB_PASSWORD
  environment_compose_guard() { bash -c '[[ "$DB_PASSWORD" == synthetic_app_only && "$MAINT_DB_PASSWORD" == synthetic_admin_only ]]'; }
  schema_writer_services() { bash -c '[[ "$DB_NAME" == jkh_local_lab ]]'; }
  docker() {
    [[ "$*" == *'compose run --rm --no-deps --build'* ]]
    [[ "$*" == *'-e DB_PASSWORD'* && "$*" != *synthetic_app_only* && "$*" != *synthetic_admin_only* ]]
    bash -c '[[ "$DB_PASSWORD" == synthetic_app_only && "$MAINT_DB_PASSWORD" == synthetic_admin_only && "$RESTORE_DB_PASSWORD" == synthetic_restore_only ]]'
  }
  schema_cli diagnose
  schema_cli backup
  [[ -z "${DB_PASSWORD+x}" && -z "${MAINT_DB_PASSWORD+x}" && -z "${RESTORE_DB_PASSWORD+x}" ]]
  CUP_SCHEMA_ADMIN_ENV_FILE="$fixture/missing.env"
  if schema_cli diagnose > "$fixture/missing-env.log"; then exit 1; fi
  grep -q schema_environment_file_unreadable "$fixture/missing-env.log"
  ! grep -q synthetic_admin_only "$fixture/missing-env.log"
  CUP_SCHEMA_ADMIN_ENV_FILE="$fixture/schema-admin.env"
  printf '%s\n' 'MAINT_DB_NAME=wrong_database' >> "$CUP_SCHEMA_ADMIN_ENV_FILE"
  if schema_cli diagnose > "$fixture/wrong-env.log"; then exit 1; fi
  grep -q schema_environment_identity_mismatch "$fixture/wrong-env.log"
)
echo 'PASS: scoped file loading exports all credentials only to the one-off tool and rejects invalid identities'

# Reuse the complete proven v5.4.1 suite against v5.5 without changing old files.
# Only the source path/version expectation is adjusted in a disposable harness.
"${CUP_HOST_PYTHON:-python}" - "$menu" "$fixture/reused-v541.sh" <<'REUSE'
from pathlib import Path
import sys
menu=Path(sys.argv[1]);s=(menu.parent/'test_server_menu_v5_4.sh').read_text(encoding='utf8')
s=s.replace('menu="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/jkh_server_menu_v5_4.sh"','menu='+repr(menu.as_posix()))
s=s.replace('[[ "$VERSION" == v5.4.1 ]]','[[ "$VERSION" == v5.5 ]]')
s=s.replace('ENVIRONMENT=LAB','ENVIRONMENT=LOCAL_LAB',1)
Path(sys.argv[2]).write_text(s,encoding='utf8',newline='\n')
REUSE
bash "$fixture/reused-v541.sh"
echo 'PASS: existing isolation/lock/error regressions also pass against v5.5'
