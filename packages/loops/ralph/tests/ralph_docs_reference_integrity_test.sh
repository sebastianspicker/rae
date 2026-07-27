#!/usr/bin/env bash
# Regression coverage for Ralph's docs reference integrity contract.

set -euo pipefail

# shellcheck source=tests/lib/test_helpers.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/test_helpers.sh"

require_cmds grep

run_docs_integrity_case() {
  if [[ -d "$ROOT_DIR/plans" ]]; then
    fail_case "docs-reference-integrity" "plans directory should be removed" "" ""
  fi

  if [[ -d "$ROOT_DIR/docs" ]]; then
    fail_case "docs-reference-integrity" "legacy docs/ directory should be removed (stubs consolidated into README)" "" ""
  fi

  if grep -En 'repo-improvement-plan|umfassender-repo-verbesserungsplan|plans/' "$ROOT_DIR/README.md" "$ROOT_DIR/AGENTS.md" >/tmp/ralph-doc-rg.out 2>/dev/null; then
    fail_case "docs-reference-integrity" "found dangling references to removed plan artifacts" "/tmp/ralph-doc-rg.out" ""
  fi

  grep -q '^## Requirements$' "$ROOT_DIR/README.md" || fail_case "docs-reference-integrity" "README missing Requirements section" "$ROOT_DIR/README.md" ""
  grep -q '^## Contracts$' "$ROOT_DIR/README.md" || fail_case "docs-reference-integrity" "README missing Contracts section" "$ROOT_DIR/README.md" ""
  grep -q '^## Runtime Files$' "$ROOT_DIR/README.md" || fail_case "docs-reference-integrity" "README missing Runtime Files section" "$ROOT_DIR/README.md" ""

  printf 'PASS [docs-reference-integrity]\n'
}

run_docs_integrity_case
printf 'All docs reference integrity tests passed.\n'
