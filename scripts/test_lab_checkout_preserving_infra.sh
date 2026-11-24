#!/usr/bin/env bash
set -euo pipefail

menu="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/jkh_server_menu_v5_3.sh"
fixture="$(mktemp -d)"
temp_root="$(cd "${TMPDIR:-/tmp}" && pwd -P)"
fixture="$(cd "$fixture" && pwd -P)"
[[ "$fixture" == "$temp_root"/tmp.* ]] || { echo 'Unsafe fixture path' >&2; exit 1; }
trap 'rm -rf "$fixture"' EXIT

# Load functions without starting the interactive menu.
source <(sed '$d' "$menu")
cd "$fixture"
git init -q -b main
git config user.name 'CUP fixture'
git config user.email 'cup-fixture@example.invalid'
git config core.autocrlf false
mkdir nginx
printf 'base\n' > docker-compose.yml
printf 'base\n' > nginx/default.conf
printf 'base\n' > app.txt
git add docker-compose.yml nginx/default.conf app.txt
git commit -qm base

git switch -qc lab-a
printf 'lab-a\n' > docker-compose.yml
printf 'lab-a\n' > nginx/default.conf
printf 'lab-a\n' > app.txt
git commit -qam lab-a
git update-ref refs/remotes/origin/lab-a "$(git rev-parse HEAD)"

git switch -q main
git switch -qc lab-b
printf 'lab-b\n' > docker-compose.yml
printf 'lab-b\n' > nginx/default.conf
printf 'lab-b\n' > app.txt
git commit -qam lab-b
git update-ref refs/remotes/origin/lab-b "$(git rev-parse HEAD)"

git rm -q docker-compose.yml
git commit -qm lab-without-compose
git update-ref refs/remotes/origin/lab-without-compose "$(git rev-parse HEAD)"

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
