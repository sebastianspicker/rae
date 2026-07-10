#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG_FILE="$ROOT_DIR/.codacy/codacy.config.json"
REPORT_DIR="$ROOT_DIR/.codacy/reports"
TMP_DIR="$ROOT_DIR/.codacy/tmp"
INSPECT_FILE="$TMP_DIR/codacy-local-inspect.json"
RAW_REPORT_FILE="$TMP_DIR/codacy-local-raw.json"
SANITIZED_REPORT_FILE="$REPORT_DIR/codacy-local-sanitized.json"
NATIVE_TOOL_REPORT_FILE="$REPORT_DIR/codacy-local-native-tool-versions.json"
SUPPORTED_TOOLS_CONFIG_FILE="$TMP_DIR/codacy-supported-tools.config.json"
EXPECTED_TOOLS=(
  shellcheck
  Lizard
  Hadolint
  markdownlint
  Trivy
  Semgrep
  jackson
)
NATIVE_POLICY_TOOL_IDS=(Ruff Bandit Checkov Biome)
native_tool_versions=()

if [[ ! -f "$CONFIG_FILE" ]]; then
  printf 'ERROR: missing local Codacy configuration: %s\n' "$CONFIG_FILE" >&2
  exit 2
fi

run_codacy() {
  npm exec --yes --package=@codacy/analysis-cli@0.11.0 -- \
    codacy-analysis "$@"
}

require_inspected_version() {
  local tool_id="$1"
  local expected_version="$2"
  local actual_version

  actual_version="$(jq -r --arg tool_id "$tool_id" \
    '.capability.ready[]? | select(.toolId == $tool_id) | .version' "$INSPECT_FILE")"
  if [[ "$actual_version" != "$expected_version" ]]; then
    printf 'ERROR: Codacy adapter for %s is %s; required %s.\n' \
      "$tool_id" "${actual_version:-unavailable}" "$expected_version" >&2
    return 1
  fi
}

require_native_version() {
  local tool_id="$1"
  local expected_version="$2"
  shift 2
  local output
  local actual_version

  output="$("$@" 2>&1)"
  if [[ "$output" =~ ([0-9]+\.[0-9]+\.[0-9]+) ]]; then
    actual_version="${BASH_REMATCH[1]}"
  else
    actual_version="unavailable"
  fi

  if [[ "$actual_version" != "$expected_version" ]]; then
    printf 'ERROR: native %s is %s; required %s.\n' \
      "$tool_id" "$actual_version" "$expected_version" >&2
    return 1
  fi
  native_tool_versions+=("${tool_id}:${actual_version}")
}

run_native_policy_analysis() {
  local -a python_files
  local -a bandit_test_ids
  local -a supported_bandit_test_ids
  local -a unsupported_bandit_test_ids
  local -A supported_bandit_tests
  local bandit_tests

  printf 'Running native Ruff analysis...\n'
  ruff check "$ROOT_DIR"

  printf 'Running native Bandit analysis...\n'
  mapfile -t python_files < <(git -C "$ROOT_DIR" ls-files '*.py')
  if [[ "${#python_files[@]}" -eq 0 ]]; then
    printf 'ERROR: no tracked Python files found for Bandit.\n' >&2
    return 1
  fi
  mapfile -t bandit_test_ids < <(jq -r '
    .tools[] | select(.toolId == "Bandit") | .patterns[].patternId | sub("^Bandit_"; "")
  ' "$CONFIG_FILE")
  if [[ "${#bandit_test_ids[@]}" -eq 0 ]]; then
    printf 'ERROR: no enabled Bandit patterns found in %s.\n' "$CONFIG_FILE" >&2
    return 1
  fi
  mapfile -t supported_bandit_test_ids < <(python -c '
from bandit.core.extension_loader import MANAGER
print("\n".join(sorted(MANAGER.plugins_by_id)))
')
  for test_id in "${supported_bandit_test_ids[@]}"; do
    supported_bandit_tests["$test_id"]=1
  done
  for test_id in "${bandit_test_ids[@]}"; do
    if [[ -z "${supported_bandit_tests[$test_id]+_}" ]]; then
      unsupported_bandit_test_ids+=("$test_id")
    fi
  done
  if [[ "${#unsupported_bandit_test_ids[@]}" -gt 0 ]]; then
    printf 'ERROR: configured Bandit patterns unavailable in native Bandit: %s\n' \
      "$(IFS=,; printf '%s' "${unsupported_bandit_test_ids[*]}")" >&2
    return 1
  fi
  bandit_tests="$(IFS=,; printf '%s' "${bandit_test_ids[*]}")"
  (
    cd "$ROOT_DIR"
    bandit --quiet --tests "$bandit_tests" "${python_files[@]}"
  )

  printf 'Running native Checkov analysis...\n'
  (
    cd "$ROOT_DIR"
    checkov --directory . --quiet --compact \
      --skip-path '^\\.git($|/)' \
      --skip-path '^\\.worktrees($|/)' \
      --skip-path '^packages/orchestration/node_modules($|/)'
  )

  printf 'Running native Biome analysis...\n'
  (
    cd "$ROOT_DIR/packages/orchestration"
    ./node_modules/.bin/biome check .
  )
}

mkdir -p "$REPORT_DIR" "$TMP_DIR"

require_native_version Ruff 0.15.20 ruff --version
require_native_version Bandit 1.9.4 bandit --version
require_native_version Checkov 3.3.7 checkov --version
require_native_version Biome 2.5.2 \
  "$ROOT_DIR/packages/orchestration/node_modules/.bin/biome" --version

run_native_policy_analysis

jq -n --argjson tool_versions "$(printf '%s\n' "${native_tool_versions[@]}" | \
  jq -R 'capture("(?<toolId>[^:]+):(?<version>.+)")' | jq -s .)" \
  '{nativePolicyToolVersions: $tool_versions, analysisStatus: "passed"}' \
  > "$NATIVE_TOOL_REPORT_FILE"

jq --argjson native_tool_ids "$(printf '%s\n' "${NATIVE_POLICY_TOOL_IDS[@]}" | jq -R . | jq -s .)" '
  .tools |= map(select(.toolId as $tool_id | ($native_tool_ids | index($tool_id) | not)))
' "$CONFIG_FILE" > "$SUPPORTED_TOOLS_CONFIG_FILE"

run_codacy analyze --config-file "$SUPPORTED_TOOLS_CONFIG_FILE" --inspect --output-format json \
  > "$INSPECT_FILE"

jq -e --argjson expected_tools "$(printf '%s\n' "${EXPECTED_TOOLS[@]}" | jq -R . | jq -s .)" '
  (.errors | length == 0)
  and (.capability.unavailable | length == 0)
  and ([$expected_tools[] as $tool_id | any(.capability.ready[]?; .toolId == $tool_id)] | all)
' "$INSPECT_FILE" >/dev/null || {
  printf 'ERROR: Codacy inspect found unavailable or failed configured tools.\n' >&2
  exit 2
}

require_inspected_version Lizard 1.21.2
require_inspected_version Hadolint 2.14.0
require_inspected_version Trivy 0.69.3
require_inspected_version Semgrep 1.22.0

set +e
run_codacy analyze --config-file "$SUPPORTED_TOOLS_CONFIG_FILE" --fail-if-missing --output-format json \
  --output "$RAW_REPORT_FILE" "$@"
analysis_exit=$?
set -e

jq -e --argjson expected_tools "$(printf '%s\n' "${EXPECTED_TOOLS[@]}" | jq -R . | jq -s .)" '
  (.errors | length == 0)
  and (.toolResults | length > 0)
  and all(.toolResults[]?; .status == "success")
  and ([$expected_tools[] as $tool_id | any(.toolResults[]?; .toolId == $tool_id and .status == "success")] | all)
' "$RAW_REPORT_FILE" >/dev/null || {
  printf 'ERROR: Codacy analysis has failed or partial tools; raw report: %s\n' \
    "$RAW_REPORT_FILE" >&2
  exit 2
}

jq -f "$ROOT_DIR/scripts/sanitize-codacy-report.jq" \
  "$RAW_REPORT_FILE" > "$SANITIZED_REPORT_FILE"

issue_count="$(jq '.issues | length' "$SANITIZED_REPORT_FILE")"
if [[ "$issue_count" -ne 0 ]]; then
  printf 'ERROR: Codacy analysis found %s issue(s); sanitized report: %s\n' \
    "$issue_count" "$SANITIZED_REPORT_FILE" >&2
  exit 1
fi

if [[ "$analysis_exit" -ne 0 ]]; then
  printf 'ERROR: Codacy analysis exited %s without reported issues.\n' "$analysis_exit" >&2
  exit "$analysis_exit"
fi

printf 'Codacy local analysis passed; sanitized report: %s\n' "$SANITIZED_REPORT_FILE"
