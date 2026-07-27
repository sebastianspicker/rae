#!/usr/bin/env bash
# Test runner for coauthor-trailer-cleaner.sh
# Usage: bash tests/run-tests.sh [--filter <pattern>]
# shellcheck disable=SC1090,SC1091

set -euo pipefail

TESTS_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$TESTS_DIR/helpers.sh"

FILTER=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --filter) FILTER="$2"; shift 2 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

trap cleanup_test_dirs EXIT

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║   coauthor-trailer-cleaner test suite    ║"
echo "╚══════════════════════════════════════════╝"
echo ""

TOTAL_PASS=0
TOTAL_FAIL=0
TOTAL_SKIP=0

# Discover and run all test-*.sh files
for test_file in "$TESTS_DIR"/test-*.sh; do
  [[ -f "$test_file" ]] || continue

  file_name=$(basename "$test_file")
  echo "─── $file_name ───"

  # Capture functions before sourcing to detect new ones
  before_funcs=$(declare -F | awk '{print $3}')

  # Source the test file to get its functions
  source "$test_file"

  # Find only NEW test_ functions added by this file
  after_funcs=$(declare -F | awk '{print $3}')
  test_functions=$(comm -13 <(echo "$before_funcs" | sort) <(echo "$after_funcs" | sort) | grep '^test_' | sort)

  for func in $test_functions; do
    # Apply filter if specified
    if [[ -n "$FILTER" && "$func" != *"$FILTER"* ]]; then
      continue
    fi

    # Run test in subshell to isolate failures
    set +e
    (
      set -e
      "$func"
    )
    rc=$?
    set -e

    if [[ $rc -eq 0 ]]; then
      record_pass "$func"
      TOTAL_PASS=$((TOTAL_PASS + 1))
    elif [[ $rc -eq 2 ]]; then
      # Convention: exit 2 = skip
      record_skip "$func"
      TOTAL_SKIP=$((TOTAL_SKIP + 1))
    else
      record_fail "$func"
      TOTAL_FAIL=$((TOTAL_FAIL + 1))
    fi

    # Clean up temp dirs between tests
    cleanup_test_dirs
  done

  echo ""
done

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Results: ${GREEN}$TOTAL_PASS passed${RESET}, ${RED}$TOTAL_FAIL failed${RESET}, ${YELLOW}$TOTAL_SKIP skipped${RESET}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

if [[ $TOTAL_FAIL -gt 0 ]]; then
  exit 1
fi
exit 0
