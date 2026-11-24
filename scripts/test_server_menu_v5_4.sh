#!/usr/bin/env bash
set -euo pipefail

menu="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/jkh_server_menu_v5_4.sh"
v53="$(dirname "$menu")/jkh_server_menu_v5_3.sh"
fixture="$(mktemp -d)"
temp_root="$(cd "${TMPDIR:-/tmp}" && pwd -P)"
fixture="$(cd "$fixture" && pwd -P)"
[[ "$fixture" == "$temp_root"/tmp.* ]] || { echo 'Unsafe fixture path' >&2; exit 1; }
trap 'rm -rf "$fixture"' EXIT

# Load functions without starting the interactive menu.
source <(sed '$d' "$menu")
[[ "$VERSION" == v5.4.1 ]]
[[ "$LOCK_FILE" == /tmp/jkh_server_menu_v5_3.lock ]]
grep -Fq 'LOCK_FILE="/tmp/jkh_server_menu_v5_3.lock"' "$v53"
mkdir "$fixture/lab" "$fixture/prod"
printf 'prod-untouched\n' > "$fixture/prod/marker"
git init -q --bare "$fixture/origin.git"
cd "$fixture/lab"
git init -q -b main
git config user.name 'CUP fixture'
git config user.email 'cup-fixture@example.invalid'
git config core.autocrlf false
git remote add origin "$fixture/origin.git"
mkdir nginx
printf 'base\n' > docker-compose.yml
printf 'base\n' > nginx/default.conf
printf 'base\n' > app.txt
git add docker-compose.yml nginx/default.conf app.txt
git commit -qm base
git push -q origin main

git switch -qc lab-a
printf 'lab-a\n' > docker-compose.yml
printf 'lab-a\n' > nginx/default.conf
printf 'lab-a\n' > app.txt
git commit -qam lab-a
git push -q origin lab-a

git switch -q main
git switch -qc lab-b
printf 'lab-b\n' > docker-compose.yml
printf 'lab-b\n' > nginx/default.conf
printf 'lab-b\n' > app.txt
git commit -qam lab-b
git push -q origin lab-b

git rm -q docker-compose.yml
git commit -qm lab-without-compose
git branch lab-without-compose
git push -q origin lab-without-compose

select_branch <<< $'0\nlab-b'
[[ "$SELECTED_BRANCH" == lab-b ]]
echo 'PASS: LAB fetches and selects a branch from isolated origin'

git switch -q lab-a
printf 'server-local-compose\n' > docker-compose.yml
printf 'server-local-nginx\n' > nginx/default.conf
printf 'server-local-env\n' > .env
git update-index --skip-worktree docker-compose.yml nginx/default.conf
ENVIRONMENT=LAB

assert_infra() {
  [[ "$(cat docker-compose.yml)" == server-local-compose ]]
  [[ "$(cat nginx/default.conf)" == server-local-nginx ]]
  [[ "$(cat .env)" == server-local-env ]]
}

for selected in lab-b lab-a lab-b; do
  SELECTED_BRANCH="$selected"
  lab_checkout_test_branch_preserving_infra
  [[ "$(git branch --show-current)" == test-pr ]]
  [[ "$(git rev-parse HEAD)" == "$(git rev-parse "origin/$selected")" ]]
  assert_infra
  [[ "$(git ls-files -v docker-compose.yml)" == 'S docker-compose.yml' ]]
  [[ "$(git ls-files -v nginx/default.conf)" == 'S nginx/default.conf' ]]
done
echo 'PASS: repeated LAB branch switches preserve local infra'

printf 'local-change\n' > app.txt
before_head="$(git rev-parse HEAD)"
before_compose_index="$(git ls-files --stage docker-compose.yml)"
before_nginx_index="$(git ls-files --stage nginx/default.conf)"
SELECTED_BRANCH=lab-a
if lab_checkout_test_branch_preserving_infra; then
  echo 'FAIL: checkout with unrelated local change succeeded' >&2
  exit 1
fi
[[ "$(git rev-parse HEAD)" == "$before_head" ]]
[[ "$(git branch --show-current)" == test-pr ]]
[[ "$(git ls-files --stage docker-compose.yml)" == "$before_compose_index" ]]
[[ "$(git ls-files --stage nginx/default.conf)" == "$before_nginx_index" ]]
[[ "$(cat app.txt)" == local-change ]]
assert_infra
echo 'PASS: failed checkout restores index and preserves worktree'

SELECTED_BRANCH=lab-without-compose
if lab_checkout_test_branch_preserving_infra; then
  echo 'FAIL: missing infra file in target branch was accepted' >&2
  exit 1
fi
[[ "$(git rev-parse HEAD)" == "$before_head" ]]
[[ "$(git ls-files --stage docker-compose.yml)" == "$before_compose_index" ]]
assert_infra
echo 'PASS: target without infra file is blocked before checkout'

git update-index --no-skip-worktree docker-compose.yml
git add docker-compose.yml
git update-index --skip-worktree docker-compose.yml
staged_compose_index="$(git ls-files --stage docker-compose.yml)"
SELECTED_BRANCH=lab-a
if lab_checkout_test_branch_preserving_infra; then
  echo 'FAIL: staged infra change was accepted' >&2
  exit 1
fi
[[ "$(git rev-parse HEAD)" == "$before_head" ]]
[[ "$(git ls-files --stage docker-compose.yml)" == "$staged_compose_index" ]]
assert_infra
echo 'PASS: staged infra change is preserved and blocks checkout'

git_head="$(git rev-parse HEAD)"
ENVIRONMENT=PROD
PROJECT_DIR="$fixture/prod"
SITE_CHECK=http://127.0.0.1:8081
if deploy_test_branch no; then
  echo 'FAIL: PROD accepted a test branch' >&2
  exit 1
fi
if require_prod_confirmation 'synthetic operation' <<< 'NO'; then
  echo 'FAIL: PROD confirmation accepted NO' >&2
  exit 1
fi
[[ "$(git rev-parse HEAD)" == "$git_head" ]]
[[ "$(cat "$fixture/prod/marker")" == prod-untouched ]]
ENVIRONMENT=LAB
if require_main_scenario_prod; then
  echo 'FAIL: LAB accepted a PROD main scenario' >&2
  exit 1
fi
echo 'PASS: LAB and PROD routing guards preserve isolated PROD fixture'

cat > "$fixture/v53-lock-check.sh" <<'LOCK_TEST'
#!/usr/bin/env bash
source <(sed '$d' "$1")
LOCK_FILE="$2"
ENVIRONMENT=LAB
PROJECT_DIR="$3"
acquire_lock || exit 3
if [[ "${4:-}" == hold ]]; then
  printf 'ready\n' > "$5"
  sleep 2
fi
release_lock
LOCK_TEST

LOCK_FILE="$fixture/shared.lock"
ENVIRONMENT=LAB
PROJECT_DIR="$fixture/lab"
acquire_lock
if bash "$fixture/v53-lock-check.sh" "$v53" "$LOCK_FILE" "$PROJECT_DIR"; then
  echo 'FAIL: v5.3 entered while v5.4 held the shared lock' >&2
  exit 1
fi
release_lock
bash "$fixture/v53-lock-check.sh" "$v53" "$LOCK_FILE" "$PROJECT_DIR" hold "$fixture/ready" &
holder=$!
for ((attempt=0; attempt<30; attempt++)); do
  [[ -f "$fixture/ready" ]] && break
  sleep 0.1
done
[[ -f "$fixture/ready" ]]
if acquire_lock; then
  echo 'FAIL: v5.4 entered while v5.3 held the shared lock' >&2
  exit 1
fi
wait "$holder"
[[ ! -e "$LOCK_FILE" ]]
echo 'PASS: v5.3 and v5.4 reject operations while the other holds the shared lock'

acquire_lock
if bash "$fixture/v53-lock-check.sh" "$menu" "$LOCK_FILE" "$PROJECT_DIR"; then
  echo 'FAIL: second v5.4 entered while first v5.4 held the lock' >&2
  exit 1
fi
release_lock
echo 'PASS: overlapping v5.4 operations share an atomic lock'

cat > "$fixture/race-lock-check.sh" <<'RACE_TEST'
#!/usr/bin/env bash
source <(sed '$d' "$1")
LOCK_FILE="$2"
ENVIRONMENT=LAB
PROJECT_DIR="$3"
ready="$5"
result="$6"
peer_result="$7"
printf 'ready\n' > "$ready"
while [[ ! -f "$4" ]]; do sleep 0.01; done
if acquire_lock; then
  printf 'acquired\n' > "$result"
  for ((i=0; i<200; i++)); do
    [[ -f "$peer_result" ]] && break
    sleep 0.01
  done
  [[ -f "$peer_result" ]] || exit 4
  release_lock
else
  printf 'blocked\n' > "$result"
  exit 3
fi
RACE_TEST

for first in v53 v54; do
  lock_dir="$fixture/race-$first"
  mkdir "$lock_dir"
  if [[ "$first" == v53 ]]; then
    first_menu="$v53"
    second_menu="$menu"
  else
    first_menu="$menu"
    second_menu="$v53"
  fi
  bash "$fixture/race-lock-check.sh" "$first_menu" "$lock_dir/shared.lock" "$fixture/lab" "$lock_dir/gate" "$lock_dir/ready-first" "$lock_dir/result-first" "$lock_dir/result-second" > "$lock_dir/first.log" 2>&1 &
  first_pid=$!
  bash "$fixture/race-lock-check.sh" "$second_menu" "$lock_dir/shared.lock" "$fixture/lab" "$lock_dir/gate" "$lock_dir/ready-second" "$lock_dir/result-second" "$lock_dir/result-first" > "$lock_dir/second.log" 2>&1 &
  second_pid=$!
  for ((attempt=0; attempt<200; attempt++)); do
    [[ -f "$lock_dir/ready-first" && -f "$lock_dir/ready-second" ]] && break
    sleep 0.01
  done
  [[ -f "$lock_dir/ready-first" && -f "$lock_dir/ready-second" ]]
  printf 'go\n' > "$lock_dir/gate"
  wait "$first_pid" || true
  wait "$second_pid" || true
  [[ "$(cat "$lock_dir/result-first")" != "$(cat "$lock_dir/result-second")" ]]
  [[ ! -e "$lock_dir/shared.lock" ]]
done
echo 'PASS: simultaneous v5.3/v5.4 starts allow exactly one owner in both orders'

for checked_menu in "$v53" "$menu"; do
  error_lock="$fixture/error-$(basename "$checked_menu").lock"
  if bash -c 'source <(sed '\''$d'\'' "$1"); LOCK_FILE="$2"; ENVIRONMENT=LAB; PROJECT_DIR="$3"; acquire_lock || exit 3; exit 7' _ "$checked_menu" "$error_lock" "$fixture/lab" > /dev/null 2>&1; then
    echo 'FAIL: synthetic operation error returned success' >&2
    exit 1
  fi
  [[ ! -e "$error_lock" ]]
done
echo 'PASS: both versions release their lock on error exit'

for checked_menu in "$v53" "$menu"; do
  repeat_lock="$fixture/repeat-$(basename "$checked_menu").lock"
  for ((attempt=0; attempt<3; attempt++)); do
    bash "$fixture/v53-lock-check.sh" "$checked_menu" "$repeat_lock" "$fixture/lab" > /dev/null
    [[ ! -e "$repeat_lock" ]]
  done
  printf 'existing-lock\n' > "$repeat_lock"
  if bash "$fixture/v53-lock-check.sh" "$checked_menu" "$repeat_lock" "$fixture/lab" > /dev/null; then
    echo 'FAIL: existing lock was ignored' >&2
    exit 1
  fi
  [[ "$(cat "$repeat_lock")" == existing-lock ]]
  rm -f "$repeat_lock"
done
echo 'PASS: repeated runs release locks and existing locks remain untouched'


# Error-handling regressions load the unchanged menu functions into fresh shells.
# All environment, deployment and reporting effects below use fixture-only stubs.
cat > "$fixture/error-handling-check.sh" <<'ERROR_HANDLING_TEST'
set -euo pipefail
checked_menu="$1"
regression_case="$2"
test_dir="$3"
source <(sed '$d' "$checked_menu")
LOCK_FILE="$test_dir/menu.lock"
ENVIRONMENT=LAB
PROJECT_DIR="$test_dir"
go_project() { cd "$test_dir"; }
show_final_status() { :; }
run_basic_checks() { return 0; }

expect_status() {
  local number="$1" expected_rc="$2" expected_status="$3" actual_rc
  if run_case "$number" > "$test_dir/result.log" 2>&1; then
    actual_rc=0
  else
    actual_rc=$?
  fi
  [[ "$actual_rc" -eq "$expected_rc" ]]
  grep -q "^${expected_status}:" "$test_dir/result.log"
  if [[ "$expected_status" != SUCCESS ]]; then
    ! grep -q '^SUCCESS:' "$test_dir/result.log"
  fi
}

case "$regression_case" in
  success)
    expect_status 7 0 SUCCESS
    [[ "$LAST_ERROR" -eq 0 && ! -e "$LOCK_FILE" ]]
    ;;
  unflagged-error)
    run_basic_checks() { return 73; }
    expect_status 7 1 ERROR
    [[ "$LAST_ERROR" -eq 73 && ! -e "$LOCK_FILE" ]]
    ;;
  existing-error)
    run_basic_checks() { LAST_ERROR=17; return 73; }
    expect_status 7 1 ERROR
    [[ "$LAST_ERROR" -eq 17 && ! -e "$LOCK_FILE" ]]
    ;;
  flag-only-error)
    run_basic_checks() { LAST_ERROR=17; return 0; }
    expect_status 7 1 ERROR
    [[ "$LAST_ERROR" -eq 17 && ! -e "$LOCK_FILE" ]]
    ;;
  blocked-error|blocked-success)
    run_basic_checks() {
      block_operation 'BLOCKED: fixture-only operation'
      [[ "$regression_case" == blocked-success ]]
    }
    expect_status 7 1 BLOCKED
    [[ "$LAST_BLOCKED" -eq 1 && ! -e "$LOCK_FILE" ]]
    ;;
  subshell-error)
    run_basic_checks() { ( LAST_ERROR=73; return 73 ); }
    expect_status 7 1 ERROR
    [[ "$LAST_ERROR" -eq 73 && ! -e "$LOCK_FILE" ]]
    ;;
  final-success-preserves-error)
    run_basic_checks() { return 73; }
    show_final_status() { LAST_ERROR=0; return 0; }
    expect_status 7 1 ERROR
    [[ "$LAST_ERROR" -eq 73 && ! -e "$LOCK_FILE" ]]
    ;;
  final-return-error)
    show_final_status() { return 74; }
    expect_status 7 1 ERROR
    [[ "$LAST_ERROR" -eq 74 && ! -e "$LOCK_FILE" ]]
    ;;
  final-flag-error)
    show_final_status() { LAST_ERROR=74; return 0; }
    expect_status 7 1 ERROR
    [[ "$LAST_ERROR" -eq 74 && ! -e "$LOCK_FILE" ]]
    ;;
  original-error-priority)
    run_basic_checks() { LAST_ERROR=17; return 73; }
    show_final_status() { LAST_ERROR=74; return 74; }
    expect_status 7 1 ERROR
    [[ "$LAST_ERROR" -eq 17 && ! -e "$LOCK_FILE" ]]
    ;;
  blocked-priority)
    run_basic_checks() { block_operation 'BLOCKED: fixture-only operation'; return 1; }
    show_final_status() { LAST_ERROR=74; return 74; }
    expect_status 7 1 BLOCKED
    [[ "$LAST_BLOCKED" -eq 1 && ! -e "$LOCK_FILE" ]]
    ;;
  mktemp-error)
    check_skip_worktree_infra() { return 0; }
    prepare_deploy() { return 0; }
    select_branch() { SELECTED_BRANCH=fixture-branch; return 0; }
    mktemp() { return 73; }
    expect_status 5 1 ERROR
    [[ "$LAST_ERROR" -ne 0 && ! -e "$LOCK_FILE" ]]
    ;;
  project-error)
    go_project() { return 72; }
    run_basic_checks() { printf 'unexpected\n' > "$test_dir/action"; }
    expect_status 7 1 ERROR
    [[ "$LAST_ERROR" -eq 72 && ! -e "$LOCK_FILE" && ! -e "$test_dir/action" ]]
    ;;
  busy-lock)
    printf 'foreign-lock\n' > "$LOCK_FILE"
    run_basic_checks() { printf 'unexpected\n' > "$test_dir/action"; }
    expect_status 7 1 ERROR
    [[ "$LOCK_HELD" -eq 0 && ! -e "$test_dir/action" ]]
    [[ "$(cat "$LOCK_FILE")" == foreign-lock ]]
    ;;
  cleanup-error|cleanup-original-error|cleanup-blocked)
    if [[ "$regression_case" == cleanup-original-error ]]; then
      run_basic_checks() { LAST_ERROR=17; return 73; }
    elif [[ "$regression_case" == cleanup-blocked ]]; then
      run_basic_checks() { block_operation 'BLOCKED: fixture-only operation'; return 1; }
    fi
    rm() { return 75; }
    expected_status=ERROR
    [[ "$regression_case" != cleanup-blocked ]] || expected_status=BLOCKED
    expect_status 7 1 "$expected_status"
    [[ "$LOCK_HELD" -eq 1 && -f "$LOCK_FILE" ]]
    if [[ "$regression_case" == cleanup-original-error ]]; then
      [[ "$LAST_ERROR" -eq 17 ]]
    elif [[ "$regression_case" == cleanup-error ]]; then
      [[ "$LAST_ERROR" -eq 75 ]]
    else
      [[ "$LAST_BLOCKED" -eq 1 ]]
    fi
    unset -f rm
    release_lock
    [[ "$LOCK_HELD" -eq 0 && ! -e "$LOCK_FILE" ]]
    ;;
  replaced-lock)
    run_basic_checks() { printf 'pid=foreign env=fixture\n' > "$LOCK_FILE"; }
    expect_status 7 1 ERROR
    [[ "$(cat "$LOCK_FILE")" == 'pid=foreign env=fixture' ]]
    # This file represents another owner; cleanup must never remove it.
    LOCK_HELD=0
    ;;
  unowned-lock)
    printf 'foreign-lock\n' > "$LOCK_FILE"
    cleanup_lock
    [[ "$LOCK_HELD" -eq 0 && "$(cat "$LOCK_FILE")" == foreign-lock ]]
    ;;
  missing-owned-lock)
    run_basic_checks() { command rm -f -- "$LOCK_FILE"; }
    expect_status 7 0 SUCCESS
    [[ "$LOCK_HELD" -eq 0 && ! -e "$LOCK_FILE" ]]
    ;;
  repeated-operation)
    expect_status 7 0 SUCCESS
    [[ "$LOCK_HELD" -eq 0 && ! -e "$LOCK_FILE" ]]
    expect_status 7 0 SUCCESS
    [[ "$LOCK_HELD" -eq 0 && ! -e "$LOCK_FILE" ]]
    ;;
  all-dispatch-errors)
    for handler in deploy_main_no_build hard_reset_main deploy_main_with_build deploy_test_branch restart_services run_basic_checks show_logs safe_main_deploy full_stage_verification cherry_pick_commit dashboard safe_rollback lab_prod_readiness_preflight backup_current_environment lab_prod_deploy_wizard check_lab_prod_isolation; do
      eval "$handler() { return 73; }"
    done
    for number in 1 2 3 4 5 6 7 8 9 10 11 13 14 15 16 17 18; do
      expect_status "$number" 1 ERROR
      [[ "$LAST_ERROR" -eq 73 && ! -e "$LOCK_FILE" ]]
    done
    ;;
  invalid-menu)
    expect_status 99 1 ERROR
    [[ ! -e "$LOCK_FILE" ]]
    ;;
  interactive-continuation)
    select_environment() { :; }
    menu() { :; }
    explain() { return 0; }
    pause() { :; }
    run_case() { printf '__HANDLED_FAILURE__\n'; return 1; }
    ( main <<< $'7\ny\n7\ny\n0' ) > "$test_dir/interactive.log" 2>&1
    [[ "$(grep -c '^__HANDLED_FAILURE__$' "$test_dir/interactive.log")" -eq 2 ]]
    ;;
  *) printf 'Unknown regression case\n' >&2; exit 1 ;;
esac
printf 'PASS: %s %s\n' "$(basename "$checked_menu")" "$regression_case"
ERROR_HANDLING_TEST

for checked_menu in "$v53" "$menu"; do
  for regression_case in success unflagged-error existing-error flag-only-error blocked-error blocked-success subshell-error final-success-preserves-error final-return-error final-flag-error original-error-priority blocked-priority mktemp-error project-error busy-lock cleanup-error cleanup-original-error cleanup-blocked replaced-lock unowned-lock missing-owned-lock repeated-operation all-dispatch-errors invalid-menu interactive-continuation; do
    test_dir="$fixture/regression-$(basename "$checked_menu")-$regression_case"
    mkdir "$test_dir"
    bash "$fixture/error-handling-check.sh" "$checked_menu" "$regression_case" "$test_dir"
  done
done
