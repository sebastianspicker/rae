#!/usr/bin/env bash
# Regression coverage for Ralph's doctor command contract.

set -euo pipefail

# shellcheck source=tests/lib/test_helpers.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/test_helpers.sh"

require_cmds jq mktemp

run_doctor_text_case() {
  local tmpdir rc
  tmpdir="$(mktemp -d)"
  prepare_fixture "$tmpdir"

  rm -rf "$tmpdir/.runtime"

  set +e
  (
    cd "$tmpdir"
    MODE=audit ./ralph.sh --doctor > "$tmpdir/doctor.out" 2> "$tmpdir/doctor.err"
  )
  rc=$?
  set -e
  if [[ "$rc" -ne 0 ]]; then
    fail_case "doctor-text" "expected success, got rc=$rc" "$tmpdir/doctor.err" "$tmpdir"
  fi
  if ! grep -q '^Doctor Report$' "$tmpdir/doctor.out"; then
    fail_case "doctor-text" "missing doctor header" "$tmpdir/doctor.out" "$tmpdir"
  fi
  if [[ -d "$tmpdir/.runtime" ]]; then
    fail_case "doctor-text" "doctor command should not create .runtime" "$tmpdir/doctor.out" "$tmpdir"
  fi

  cleanup_dir "$tmpdir"
  printf 'PASS [doctor-text]\n'
}

run_doctor_json_case() {
  local tmpdir rc
  tmpdir="$(mktemp -d)"
  prepare_fixture "$tmpdir"

  set +e
  (
    cd "$tmpdir"
    MODE=audit ./ralph.sh --doctor --json > "$tmpdir/doctor.json" 2> "$tmpdir/doctor.err"
  )
  rc=$?
  set -e
  if [[ "$rc" -ne 0 ]]; then
    fail_case "doctor-json" "expected success, got rc=$rc" "$tmpdir/doctor.err" "$tmpdir"
  fi
  if ! jq -e '.command == "doctor" and (.paths.repo_root | type == "string") and (.dependencies.jq | type == "string") and (.strict_report_dir.enabled | type == "boolean")' "$tmpdir/doctor.json" >/dev/null; then
    fail_case "doctor-json" "doctor output is not valid expected JSON shape" "$tmpdir/doctor.json" "$tmpdir"
  fi

  cleanup_dir "$tmpdir"
  printf 'PASS [doctor-json]\n'
}

run_doctor_text_case
run_doctor_json_case
printf 'All doctor command tests passed.\n'
