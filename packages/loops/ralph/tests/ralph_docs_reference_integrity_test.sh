#!/usr/bin/env bash

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

  grep -q '^## Configuration$' "$ROOT_DIR/README.md" || fail_case "docs-reference-integrity" "README missing Configuration section" "$ROOT_DIR/README.md" ""
  grep -q '^## Operations$' "$ROOT_DIR/README.md" || fail_case "docs-reference-integrity" "README missing Operations section" "$ROOT_DIR/README.md" ""
  grep -q '^## How It Works$' "$ROOT_DIR/README.md" || fail_case "docs-reference-integrity" "README missing How It Works section" "$ROOT_DIR/README.md" ""
  grep -q '<a id="loop-flow"></a>' "$ROOT_DIR/README.md" || fail_case "docs-reference-integrity" "README missing loop-flow compatibility anchor" "$ROOT_DIR/README.md" ""
  grep -q '^## CLI Reference$' "$ROOT_DIR/README.md" || fail_case "docs-reference-integrity" "README missing CLI Reference section" "$ROOT_DIR/README.md" ""

  printf 'PASS [docs-reference-integrity]\n'
}

run_docs_integrity_case
printf 'All docs reference integrity tests passed.\n'
