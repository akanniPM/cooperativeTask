#!/usr/bin/env bash
set -euo pipefail

MODE=""
OUTPUT_PATH=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --output_path)
      OUTPUT_PATH="$2"
      shift 2
      ;;
    base|new)
      MODE="$1"
      shift
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

if [[ -z "$MODE" ]]; then
  echo "Usage: $0 <base|new> [--output_path <path>]" >&2
  exit 1
fi

ARGS=(run --reporter=default --passWithNoTests)
if [[ -n "$OUTPUT_PATH" ]]; then
  ARGS+=(--reporter=junit --outputFile="$OUTPUT_PATH")
fi

case "$MODE" in
  base)
    # A CLI --exclude overrides the custom `exclude` list in vitest.config.ts,
    # so the known-flaky timing benchmarks (excluded there) must be re-listed
    # here to keep base mode deterministic. The graded feature file is excluded
    # because it is exercised separately by `new` mode.
    exec pnpm exec vitest "${ARGS[@]}" --dir test \
      --exclude '**/cooperative-abort.test.ts' \
      --exclude '**/basic-async-hrtime-now.test.ts' \
      --exclude '**/basic-async-performance-now.test.ts' \
      --exclude '**/basic-sync-hrtime-now.test.ts' \
      --exclude '**/basic-sync-performane-now.test.ts'
    ;;
  new)
    exec pnpm exec vitest "${ARGS[@]}" test/cooperative-abort.test.ts
    ;;
esac
