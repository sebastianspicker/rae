#!/usr/bin/env bash
# Test helpers for coauthor-trailer-cleaner.sh test suite.

set -euo pipefail

SCRIPT_PATH="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/coauthor-trailer-cleaner.sh"
LIB1_PATH="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib/coauthor-trailer-cleaner.part1.sh"
TEST_TEMP_DIRS=()
DEFAULT_TARGET_NAME="Cursor"
DEFAULT_TARGET_EMAIL="cursoragent@cursor.com"

# Colors (respect NO_COLOR)
if [[ -t 1 && -z "${NO_COLOR:-}" ]]; then
  GREEN=$'\033[32m' RED=$'\033[31m' YELLOW=$'\033[33m' RESET=$'\033[0m'
else
  GREEN="" RED="" YELLOW="" RESET=""
fi

PASS_COUNT=0
FAIL_COUNT=0
SKIP_COUNT=0

# ── Test Lifecycle ──────────────────────────────────────────────

# Create a temp directory for test isolation. Returns path via stdout.
create_test_dir() {
  local dir
  dir=$(mktemp -d)
  TEST_TEMP_DIRS+=("$dir")
  echo "$dir"
}

# Clean up all test temp directories.
cleanup_test_dirs() {
  for d in "${TEST_TEMP_DIRS[@]}"; do
    [[ -d "$d" ]] && rm -rf "$d"
  done
  TEST_TEMP_DIRS=()
}

# Format a co-author trailer line.
format_trailer() {
  local name="$1"
  local email="$2"
  printf 'Co-authored-by: %s <%s>' "$name" "$email"
}

# Set up a test git repo with configurable co-author trailers.
# Creates 3 commits: 2 with target trailer, 1 without.
# Returns the repo path via stdout.
setup_test_repo() {
  local target_name="${1:-$DEFAULT_TARGET_NAME}"
  local target_email="${2:-$DEFAULT_TARGET_EMAIL}"
  local dir
  dir=$(create_test_dir)
  local repo="$dir/test-repo"
  mkdir -p "$repo"
  git -C "$repo" init -q
  git -C "$repo" config user.name "Test User"
  git -C "$repo" config user.email "test@test.local"

  # Commit 1: with target trailer
  echo "file1" > "$repo/file1.txt"
  git -C "$repo" add file1.txt
  git -C "$repo" commit -q -m "$(printf 'Add file1\n\n%s' "$(format_trailer "$target_name" "$target_email")")"

  # Commit 2: without target trailer
  echo "file2" > "$repo/file2.txt"
  git -C "$repo" add file2.txt
  git -C "$repo" commit -q -m "Add file2 (no trailer)"

  # Commit 3: with target trailer
  echo "file3" > "$repo/file3.txt"
  git -C "$repo" add file3.txt
  git -C "$repo" commit -q -m "$(printf 'Add file3\n\n%s' "$(format_trailer "$target_name" "$target_email")")"

  echo "$repo"
}

# Set up a test repo WITHOUT matching trailers.
setup_clean_test_repo() {
  local dir
  dir=$(create_test_dir)
  local repo="$dir/clean-repo"
  mkdir -p "$repo"
  git -C "$repo" init -q
  git -C "$repo" config user.name "Test User"
  git -C "$repo" config user.email "test@test.local"

  echo "hello" > "$repo/hello.txt"
  git -C "$repo" add hello.txt
  git -C "$repo" commit -q -m "Initial commit"

  echo "$repo"
}

# ── Assertions ──────────────────────────────────────────────────

assert_equals() {
  local expected="$1" actual="$2" msg="${3:-}"
  if [[ "$expected" == "$actual" ]]; then
    return 0
  fi
  echo "    ${RED}ASSERTION FAILED${RESET}: ${msg:-expected '$expected', got '$actual'}"
  echo "      expected: '$expected'"
  echo "      actual:   '$actual'"
  return 1
}

assert_contains() {
  local haystack="$1" needle="$2" msg="${3:-}"
  if [[ "$haystack" == *"$needle"* ]]; then
    return 0
  fi
  echo "    ${RED}ASSERTION FAILED${RESET}: ${msg:-expected to contain '$needle'}"
  return 1
}

assert_not_contains() {
  local haystack="$1" needle="$2" msg="${3:-}"
  if [[ "$haystack" != *"$needle"* ]]; then
    return 0
  fi
  echo "    ${RED}ASSERTION FAILED${RESET}: ${msg:-expected NOT to contain '$needle'}"
  return 1
}

assert_file_exists() {
  local path="$1" msg="${2:-}"
  if [[ -f "$path" ]]; then
    return 0
  fi
  echo "    ${RED}ASSERTION FAILED${RESET}: ${msg:-file does not exist: $path}"
  return 1
}

assert_exit_code() {
  local expected_code="$1"
  shift
  local actual_code=0
  "$@" >/dev/null 2>&1 || actual_code=$?
  if [[ $actual_code -eq $expected_code ]]; then
    return 0
  fi
  echo "    ${RED}ASSERTION FAILED${RESET}: expected exit code $expected_code, got $actual_code"
  return 1
}

# ── Skip Helpers ────────────────────────────────────────────────

skip_if_no_filter_repo() {
  if ! command -v git-filter-repo >/dev/null 2>&1; then
    echo "    ${YELLOW}SKIPPED${RESET}: git-filter-repo not installed"
    return 1
  fi
  return 0
}

# ── Test Runner Helpers ─────────────────────────────────────────

# Record a test pass
record_pass() {
  local name="$1"
  PASS_COUNT=$((PASS_COUNT + 1))
  echo "  ${GREEN}PASS${RESET} $name"
}

# Record a test fail
record_fail() {
  local name="$1"
  FAIL_COUNT=$((FAIL_COUNT + 1))
  echo "  ${RED}FAIL${RESET} $name"
}

# Record a test skip
record_skip() {
  local name="$1"
  SKIP_COUNT=$((SKIP_COUNT + 1))
  echo "  ${YELLOW}SKIP${RESET} $name"
}
