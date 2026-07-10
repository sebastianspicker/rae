#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG_FILE="$ROOT_DIR/.codacy/codacy.config.json"
REPORT_DIR="$ROOT_DIR/.codacy/reports"
TMP_DIR="$ROOT_DIR/.codacy/tmp"
INSPECT_FILE="$TMP_DIR/codacy-local-inspect.json"
RAW_REPORT_FILE="$TMP_DIR/codacy-local-raw.json"
SANITIZED_REPORT_FILE="$REPORT_DIR/codacy-local-sanitized.json"
EXPECTED_TOOLS=(
  shellcheck
  Bandit
  Lizard
  Hadolint
  markdownlint
  Trivy
  Semgrep
  jackson
  Ruff
  Checkov
  Biome
)

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

mkdir -p "$REPORT_DIR" "$TMP_DIR"

run_codacy analyze --config-file "$CONFIG_FILE" --inspect --output-format json \
  > "$INSPECT_FILE"

jq -e --argjson expected_tools "$(printf '%s\n' "${EXPECTED_TOOLS[@]}" | jq -R . | jq -s .)" '
  (.errors | length == 0)
  and (.capability.unavailable | length == 0)
  and ([$expected_tools[] as $tool_id | any(.capability.ready[]?; .toolId == $tool_id)] | all)
' "$INSPECT_FILE" >/dev/null || {
  printf 'ERROR: Codacy inspect found unavailable or failed configured tools.\n' >&2
  exit 2
}

require_inspected_version Ruff 0.15.20
require_inspected_version Bandit 1.9.4
require_inspected_version Checkov 3.3.7
require_inspected_version Biome 2.5.2

set +e
run_codacy analyze --config-file "$CONFIG_FILE" --fail-if-missing --output-format json \
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
