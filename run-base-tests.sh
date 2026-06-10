#!/usr/bin/env bash
set -euo pipefail
export PATH="/mnt/c/nvm4w/nodejs:/mnt/c/Users/alhaj/AppData/Roaming/npm:$PATH"
cd /mnt/c/Users/alhaj/Desktop/shipd/002/cooperativeTask
bash test.sh base > /tmp/base-results.txt 2>&1
EXIT_CODE=$?
echo "BASE_EXIT_CODE=$EXIT_CODE"
/usr/bin/grep -E "Test Files|Tests |FAIL|cooperative" /tmp/base-results.txt || true
