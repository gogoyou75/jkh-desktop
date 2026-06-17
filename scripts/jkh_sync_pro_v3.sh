#!/usr/bin/env bash
set -euo pipefail

MODE="${MODE:-LAB}"

SOURCE_FILE="/root/jkh-lab/scripts/jkh_server_menu_v5.sh"
TARGET_FILE="scripts/jkh_server_menu_v5.sh"
COMMIT_MESSAGE="SYNC PRO v3: server menu sync (stable)"

if [[ "$MODE" == "PROD" ]]; then
  echo "PROD MODE ACTIVE - be careful"
fi

echo "[1/5] check source"
if [[ ! -f "$SOURCE_FILE" ]]; then
  echo "ERROR: source file not found: $SOURCE_FILE" >&2
  exit 1
fi

echo "[2/5] copy file"
cp "$SOURCE_FILE" "$TARGET_FILE"
echo "File updated from server"

echo "[3/5] git add"
git add "$TARGET_FILE"

echo "[4/5] git commit"
git commit -m "$COMMIT_MESSAGE"

echo "[5/5] done"
echo "Next: git push (manual step)"
