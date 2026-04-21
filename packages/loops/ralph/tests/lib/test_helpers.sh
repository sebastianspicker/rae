#!/usr/bin/env bash
# Shared test bootstrap. Each test should source this with:
#   source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/test_helpers.sh"
# so TESTS_DIR, ROOT_DIR, and helpers (require_cmd, fail_case, etc.) are available.

TESTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT_DIR="$(cd "$TESTS_DIR/.." && pwd)"
LIB_DIR="$ROOT_DIR/lib/ralph"
# shellcheck source=lib/ralph/compat.sh
source "$ROOT_DIR/lib/ralph/compat.sh"
ralph_mktemp_init

RUNNER="$ROOT_DIR/ralph.sh"
PRD_FILE="$ROOT_DIR/prd.json"
PRD_SCHEMA_FILE="$ROOT_DIR/prd.schema.json"
PRD_VALIDATE_FILTER_FILE="$ROOT_DIR/prd.validate.jq"
POLICY_FILE="$ROOT_DIR/INSTRUCTIONS.md"

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    printf 'missing dependency: %s\n' "$1" >&2
    exit 1
  }
}

require_cmds() {
  local cmd
  for cmd in "$@"; do
    require_cmd "$cmd"
  done
}

print_log_excerpt() {
  local log_file="$1"
  if [[ -n "$log_file" && -s "$log_file" ]]; then
    sed -n '1,120p' "$log_file" >&2
  fi
}

cleanup_dir() {
  local dir="$1"
  if [[ -n "$dir" ]]; then
    rm -rf "$dir"
  fi
}

terminate_pid_if_running() {
  local pid="${1:-}"
  if [[ -n "$pid" ]]; then
    if ps -p "$pid" > /dev/null 2>&1; then
      kill "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
    fi
  fi
}

fail_case() {
  local case_name="$1"
  local message="$2"
  local log_file="${3:-}"
  local tmpdir="${4:-}"

  printf 'FAIL [%s]: %s\n' "$case_name" "$message" >&2
  print_log_excerpt "$log_file"
  cleanup_dir "$tmpdir"
  exit 1
}

prepare_fixture() {
  local dir="$1"
  cp "$RUNNER" "$dir/ralph.sh"
  cp "$PRD_FILE" "$dir/prd.json"
  cp "$PRD_SCHEMA_FILE" "$dir/prd.schema.json"
  cp "$PRD_VALIDATE_FILTER_FILE" "$dir/prd.validate.jq"
  cp "$POLICY_FILE" "$dir/INSTRUCTIONS.md"
  mkdir -p "$dir/lib/ralph"
  cp "$LIB_DIR"/*.sh "$dir/lib/ralph/"
}

prepare_runner_and_tool() {
  local dir="$1"
  cp "$RUNNER" "$dir/ralph.sh"
  cp "$PRD_SCHEMA_FILE" "$dir/prd.schema.json"
  cp "$PRD_VALIDATE_FILTER_FILE" "$dir/prd.validate.jq"
  cp "$POLICY_FILE" "$dir/INSTRUCTIONS.md"
  mkdir -p "$dir/lib/ralph"
  cp "$LIB_DIR"/*.sh "$dir/lib/ralph/"
}
