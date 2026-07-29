#!/usr/bin/env bash
# Verifies Codacy report sanitization removes local and unstable data.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

marker="MUST_NOT_SURVIVE_SANITIZATION"
input="$TMP_DIR/input.json"
output="$TMP_DIR/output.json"

jq -n --arg marker "$marker" '{
  metadata: {startedAt: "now", repositoryRoot: "/private/worktree"},
  toolResults: [{toolId: "Example", status: "success", message: $marker}],
  issues: [{toolId: "Example", patternId: "RULE", filePath: "src/a.ts", line: 1, column: 1, severity: "High", category: "Security", lineContent: $marker, message: $marker}],
  errors: [{toolId: "Example", filePath: "src/a.ts", phase: "parse", message: $marker}],
  unknown: $marker
}' > "$input"

jq -f "$ROOT_DIR/scripts/sanitize-codacy-report.jq" "$input" > "$output"
if rg -q "$marker|lineContent|repositoryRoot|message|unknown" "$output"; then
  printf 'ERROR: Codacy report sanitizer retained free-form content\n' >&2
  exit 1
fi

jq -e '.schemaVersion == 1 and .issues[0].patternId == "RULE"' "$output" >/dev/null
