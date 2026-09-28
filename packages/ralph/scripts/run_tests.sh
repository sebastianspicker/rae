#!/usr/bin/env bash
# Run all ralph test suites. Optionally filter by pattern.
#
# Usage:
#   ./scripts/run_tests.sh             # run all tests
#   ./scripts/run_tests.sh scope       # run tests matching *scope*
#   ./scripts/run_tests.sh --help

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TESTS_DIR="$SCRIPT_DIR/../tests"
FILTER="${1:-}"

if [[ "$FILTER" == "--help" || "$FILTER" == "-h" ]]; then
  printf 'Usage: %s [filter]\n\n' "$(basename "$0")"
  printf 'Run all tests/ralph_*.sh test files.\n'
  printf 'If filter is given, only tests matching *filter* are run.\n'
  exit 0
fi

total=0
passed_count=0
failed_count=0
failed_names=()
start_time="$(date +%s)"

for test_file in "$TESTS_DIR"/ralph_*_test.sh; do
  [[ -f "$test_file" ]] || continue
  test_name="$(basename "$test_file")"

  if [[ -n "$FILTER" && "$test_name" != *"$FILTER"* ]]; then
    continue
  fi

  total=$((total + 1))
  printf '%-60s ' "$test_name"

  test_start="$(date +%s)"
  if bash "$test_file" > /dev/null 2>&1; then
    test_end="$(date +%s)"
    elapsed=$((test_end - test_start))
    printf 'PASS (%ds)\n' "$elapsed"
    passed_count=$((passed_count + 1))
  else
    test_end="$(date +%s)"
    elapsed=$((test_end - test_start))
    printf 'FAIL (%ds)\n' "$elapsed"
    failed_count=$((failed_count + 1))
    failed_names+=("$test_name")
  fi
done

end_time="$(date +%s)"
total_elapsed=$((end_time - start_time))

printf '\n── Test Summary ──────────────────\n'
printf '  Total:   %d\n' "$total"
printf '  Passed:  %d\n' "$passed_count"
printf '  Failed:  %d\n' "$failed_count"
printf '  Elapsed: %ds\n' "$total_elapsed"
printf '──────────────────────────────────\n'

if [[ "$failed_count" -gt 0 ]]; then
  printf '\nFailed tests:\n'
  for name in "${failed_names[@]}"; do
    printf '  - %s\n' "$name"
  done
  exit 1
fi

if [[ "$total" -eq 0 ]]; then
  printf 'No tests matched.\n'
  exit 1
fi

printf '\nAll tests passed.\n'
