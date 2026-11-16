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
[[ "$VERSION" == v5.4 ]]
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
