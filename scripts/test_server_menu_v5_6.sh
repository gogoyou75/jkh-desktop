#!/usr/bin/env bash
set -euo pipefail
scripts="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fixture="$(mktemp -d)"
export CUP_V56_HELPER="$scripts/cup_config.py"
source <(sed '$d' "$scripts/jkh_server_menu_v5_6.sh")
[[ "$VERSION" == v5.6 ]]
ENVIRONMENT=LOCAL_LAB
PROJECT_DIR="$fixture/project"
mkdir -p "$PROJECT_DIR"
LOCK_FILE="$fixture/menu.lock"
CUP_HOST_PYTHON="${CUP_HOST_PYTHON:-python}"

case_cycle() (
  local mode="$1" fail_action="${2:-}" fail_code="${3:-1}" code=0
  local actions="$fixture/actions-$mode-$fail_action"
  : > "$actions"
  go_project() { return 0; };acquire_lock() { LOCK_HELD=1; };release_lock() { LOCK_HELD=0; };show_final_status() { return 0; }
  require_prod_confirmation() { return 0; }
  schema_cli() {
    echo "$1" >> "$actions"
    if [ "$1" = "$fail_action" ];then
      if [ "$fail_code" -eq 2 ];then block_operation 'BLOCKED: synthetic precondition';fi
      return "$fail_code"
    fi
    if [ "$1" = workflow-plan ];then
      V56_LAST_JSON="$fixture/plan-$mode.json"
      if [ "$mode" = noop ];then
        printf '%s' '{"status":"SUCCESS","plan_id":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","action":"noop","revision":"cup_5502","needs_resume":false,"required_changes":[],"recommendations":[]}' > "$V56_LAST_JSON"
      else
        printf '%s' '{"status":"SUCCESS","plan_id":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","action":"upgrade","revision":"cup_5502","needs_resume":false,"required_changes":[{"kind":"missing_table","table":"bulk_calc_verify_jobs"}],"recommendations":[]}' > "$V56_LAST_JSON"
      fi
    fi
  }
  schema_maintenance_begin() { echo fence >> "$actions";V56_DB_STATE=FENCED;V56_APP_STATE=STOPPED; }
  schema_maintenance_resume() { echo resume >> "$actions";[ "$fail_action" != start-api ]; }
  v56_health() {
    echo health >> "$actions"
    if [ "$fail_action" = health ];then V56_APP_STATE=FAILED;return 1;fi
    V56_APP_STATE=HEALTHY
  }
  if run_case 19 <<< $'19.9\nAPPROVE LOCAL_LAB' > "$fixture/cycle-$mode-$fail_action.log";then code=0;else code=$?;fi
  if [ -z "$fail_action" ];then
    [[ "$code" -eq 0 ]];grep -q '^RESULT: SUCCESS' "$fixture/cycle-$mode-$fail_action.log"
    if [ "$mode" = noop ];then ! grep -qE 'fence|backup|apply|resume' "$actions";fi
  else
    [[ "$code" -ne 0 ]];! grep -q '^RESULT: SUCCESS' "$fixture/cycle-$mode-$fail_action.log"
    if [ "$fail_code" -eq 2 ];then grep -q '^RESULT: BLOCKED' "$fixture/cycle-$mode-$fail_action.log";else grep -q '^RESULT: FAILED' "$fixture/cycle-$mode-$fail_action.log";fi
    if [ "$fail_action" = workflow-backup ] || [ "$fail_action" = workflow-apply ];then ! grep -q resume "$actions";fi
    if [ "$fail_action" = health ] || [ "$fail_action" = start-api ];then [[ "$V56_DB_STATE" == VERIFIED ]];! grep -q workflow-complete "$actions";fi
  fi
  [[ "$LOCK_HELD" -eq 0 ]]
)
case_cycle full
echo 'PASS: full automatic UI sequence completes with one environment/plan approval'
case_cycle noop
echo 'PASS: current schema completes without approval stop backup or migration'
for action in workflow-backup workflow-apply health start-api;do
  case_cycle full "$action"
  echo "PASS: $action failure cannot become SUCCESS and cannot continue unsafe stages"
done
for action in workflow-plan workflow-approve workflow-apply;do
  case_cycle full "$action" 2
  echo "PASS: $action refusal preserves BLOCKED and stops the cycle"
done

(
  local_calls="$fixture/manual-calls";: > "$local_calls"
  schema_cli() { echo "$1" >> "$local_calls"; }
  v56_value() { echo VERIFIED; }
  v56_preview() { echo plan >> "$local_calls"; };v56_approve() { echo approve >> "$local_calls"; }
  schema_maintenance_begin() { echo fence >> "$local_calls"; };schema_maintenance_resume() { echo resume >> "$local_calls"; }
  v56_health() { return 0; };require_prod_confirmation() { return 0; };v56_view_logs() { echo journal >> "$local_calls"; }
  for choice in 19.1 19.2 19.3 19.4 19.5 19.6 19.7 19.8;do schema_menu <<< "$choice"$'\nRESUME' >/dev/null;done
  for action in diagnose versions migrations plan workflow-backup workflow-apply workflow-verify resume journal;do grep -q "$action" "$local_calls";done
)
echo 'PASS: all manual operations 19.1-19.8 remain routed without identifier input'

(
  go_project() { return 0; };acquire_lock() { return 0; };release_lock() { return 0; };show_final_status() { return 0; }
  for handler in deploy_main_no_build hard_reset_main deploy_main_with_build deploy_test_branch restart_services run_basic_checks show_logs safe_main_deploy full_stage_verification cherry_pick_commit dashboard safe_rollback lab_prod_readiness_preflight backup_current_environment lab_prod_deploy_wizard check_lab_prod_isolation;do eval "$handler() { return 73; }";done
  for choice in 1 2 3 4 5 6 7 8 9 10 11 13 14 15 16 17 18;do
    if run_case "$choice" > "$fixture/dispatch.log";then exit 1;fi
    grep -q '^RESULT: FAILED' "$fixture/dispatch.log";! grep -q '^RESULT: SUCCESS' "$fixture/dispatch.log"
  done
)
echo 'PASS: every existing handler propagates failure into the unified report'

(
  mkdir -p "$PROJECT_DIR/backend"
  echo '{}' > "$PROJECT_DIR/compose.json"
  export COMPOSE_FILE="$PROJECT_DIR/compose.json" COMPOSE_PATH_SEPARATOR='|'
  count="$fixture/build-count";: > "$count"
  schema_compose_guard() { return 0; };schema_writer_services() { return 0; }
  v56_build_scoped() { echo build >> "$count"; }
  v56_build_context_guard() { return 0; }
  v56_image_version_check() { return 0; }
  schema_compose() { echo '{"name":"cup_fixture","services":{"api":{"image":"cup_fixture_api"}}}'; }
  docker() { printf 'sha256:%064d\n' 0; }
  v56_prepare_tool;first="$V56_IMAGE";v56_prepare_tool
  [[ "$(wc -l < "$count")" -eq 1 && "$V56_IMAGE" == "$first" ]]
  saved="$(cat "$V56_OVERRIDE")";printf '{}' > "$V56_OVERRIDE"
  if v56_prepare_tool 2>/dev/null;then exit 1;fi
  [[ "$LAST_BLOCKED" -eq 1 ]];printf '%s' "$saved" > "$V56_OVERRIDE";LAST_BLOCKED=0;LAST_ERROR=0
  V56_AUTO=1;echo '# changed' > "$PROJECT_DIR/backend/changed.py"
  if v56_prepare_tool;then exit 1;fi
  [[ "$LAST_BLOCKED" -eq 1 ]]
)
echo 'PASS: one tool build per immutable cycle and changed application blocks continuation'

(
  schema_environment() { export MAINT_DB_PASSWORD=synthetic-private;return 0; }
  v56_compose() { echo 'password=synthetic-private';return 29; }
  v56_private_dir
  if v56_build_scoped;then exit 1;else rc=$?;fi
  [[ "$rc" -eq 29 ]]
  ! grep -q synthetic-private "$PROJECT_DIR/.schema-state/LOCAL_LAB/logs/tool-build.log"
  [[ -z "$(find "$PROJECT_DIR/.schema-state/LOCAL_LAB/logs" -name '.*raw*' -print)" ]]
)
echo 'PASS: build errors survive redaction and no raw credential log is written'

(
  schema_compose() { echo 'unavailable';return 1; }
  check_site() { return 0; };check_api() { return 0; }
  mkdir -p "$PROJECT_DIR/backend";echo '# test' > "$PROJECT_DIR/backend/app.py"
  if v56_health;then exit 1;fi
  [[ "$V56_APP_STATE" == FAILED ]]
)
echo 'PASS: healthy HTTP without a verified backend version is not SUCCESS'

(
  export CUP_SCHEMA_DB_ENV_FILE="$fixture/db.env" CUP_SCHEMA_ADMIN_ENV_FILE="$fixture/admin.env"
  echo fixture > "$CUP_SCHEMA_DB_ENV_FILE";echo fixture > "$CUP_SCHEMA_ADMIN_ENV_FILE"
  schema_compose() { local p="$PROJECT_DIR/backend";if command -v cygpath >/dev/null;then p="$(cygpath -m "$p")";fi;printf '{"services":{"api":{"build":{"context":"%s"}}}}' "$p"; }
  v56_build_context_guard
  schema_compose() { local p="$PROJECT_DIR";if command -v cygpath >/dev/null;then p="$(cygpath -m "$p")";fi;printf '{"services":{"api":{"build":{"context":"%s"}}}}' "$p"; }
  if v56_build_context_guard 2>/dev/null;then exit 1;fi
)
echo 'PASS: Docker build cannot include protected credentials or workflow state'

if [ -n "${CUP_V56_TEST_IMAGE_ID:-}" ];then
  (
    [[ "$CUP_V56_TEST_IMAGE_ID" =~ ^sha256:[a-f0-9]{64}$ ]]
    PROJECT_DIR="$(cd "$scripts/.." && pwd)";V56_IMAGE="$CUP_V56_TEST_IMAGE_ID"
    docker() { command docker --host npipe:////./pipe/dockerDesktopLinuxEngine "$@"; }
    v56_image_version_check
  )
  echo 'PASS: real isolated read-only tool image matches backend and all pinned dependencies'
fi

(
  mkdir -p "$PROJECT_DIR/.schema-state/LOCAL_LAB"
  printf '%s' '{"phase":"FENCED"}' > "$PROJECT_DIR/.schema-state/LOCAL_LAB/maintenance.json"
  restart_services() { touch "$fixture/unsafe-restart"; }
  if run_case 6 > "$fixture/fence-report.log";then exit 1;fi
  grep -q '^RESULT: BLOCKED' "$fixture/fence-report.log";[[ ! -f "$fixture/unsafe-restart" ]]
)
echo 'PASS: active maintenance cannot be bypassed through existing restart/update menu items'

(
  MYSQL_ROOT_PASSWORD=synthetic-root;DB_PASSWORD_EFFECTIVE=synthetic-app;MYSQL_CONTAINER=cup_fixture
  docker() { [[ "$*" != *synthetic-root* && "$*" != *synthetic-app* && "$*" == *'-e MYSQL_PWD '* ]]; }
  DB_NAME_EFFECTIVE=cup_fixture;DB_USER_EFFECTIVE=synthetic_app
  mysql_root_dump "$fixture/synthetic-dump.sql";mysql_app_check
)
echo 'PASS: inherited MySQL checks pass passwords through transient environment rather than argv'

(
  mkdir -p "$PROJECT_DIR/.schema-state/LOCAL_LAB" "$PROJECT_DIR/backend"
  printf '%s' '{"phase":"RESUMED"}' > "$PROJECT_DIR/.schema-state/LOCAL_LAB/maintenance.json"
  printf '%s\n' api > "$PROJECT_DIR/.schema-state/LOCAL_LAB/services-before.txt"
  echo '# synthetic app' > "$PROJECT_DIR/backend/app.py"
  expected="$("$CUP_HOST_PYTHON" -c 'import hashlib,pathlib,sys;print(hashlib.sha256(pathlib.Path(sys.argv[1]).read_bytes().replace(b"\r\n",b"\n")).hexdigest())' "$PROJECT_DIR/backend/app.py")"
  schema_writer_services() { echo api; };schema_cli() { return 0; }
  schema_compose() { case "$1" in exec) echo "$expected" ;; start) return 0 ;; *) return 1 ;; esac; }
  check_site() { return 0; };check_api() { return 1; }
  schema_maintenance_resume
  [[ -f "$PROJECT_DIR/.schema-state/LOCAL_LAB/services-before.txt" ]]
  if v56_health;then exit 1;fi
  [[ -f "$PROJECT_DIR/.schema-state/LOCAL_LAB/services-before.txt" ]]
  check_api() { return 0; }
  schema_maintenance_resume;v56_health
  [[ ! -f "$PROJECT_DIR/.schema-state/LOCAL_LAB/services-before.txt" ]]
)
echo 'PASS: failed API health retains original service list until a verified retry succeeds'

(
  v56_prepare_tool() { v56_private_dir; }
  schema_cli_scoped() { printf '%s' "$payload" > "$V56_LAST_JSON";return 0; }
  for payload in '{"status":"UNKNOWN"}' '{"status":"SUCCESS"}';do
    if schema_cli workflow-apply > "$fixture/unconfirmed-result.log" 2>&1;then exit 1;fi
    [[ "$LAST_ERROR" -ne 0 ]]
  done
  payload='{"status":"SUCCESS","phase":"VERIFIED"}';LAST_ERROR=0
  schema_cli workflow-apply >/dev/null
)
echo 'PASS: zero exit with unknown or incomplete result is not reported as SUCCESS'
