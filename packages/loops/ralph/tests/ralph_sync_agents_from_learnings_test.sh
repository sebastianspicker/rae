#!/usr/bin/env bash
# Regression coverage for Ralph's sync agents from learnings contract.

set -euo pipefail

# shellcheck source=tests/lib/test_helpers.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/test_helpers.sh"

require_cmds mktemp grep

SYNC_SCRIPT="$ROOT_DIR/scripts/sync_agents_from_learnings.sh"

run_case() {
  local tmpdir rc
  tmpdir="$(mktemp -d)"
  mkdir -p "$tmpdir/lib/ralph"

  cp "$ROOT_DIR/lib/ralph/compat.sh" "$tmpdir/lib/ralph/compat.sh"

  cat > "$tmpdir/AGENTS.md" <<'EOF'
# Agent Guide
EOF

  cat > "$tmpdir/learnings.md" <<'EOF'
# Ralph Learnings (Append-Only)

## Learning Log

### 2026-02-17T10:00:00Z UTC | FIX-001
- Note: Keep path confinement checks before writes
EOF

  set +e
  "$SYNC_SCRIPT" --root "$tmpdir" > "$tmpdir/out.log" 2>&1
  rc=$?
  set -e
  if [[ "$rc" -ne 0 ]]; then
    fail_case "sync-agents-from-learnings" "expected first sync success, got rc=$rc" "$tmpdir/out.log" "$tmpdir"
  fi
  if ! grep -q '^## Learned Patterns$' "$tmpdir/AGENTS.md"; then
    fail_case "sync-agents-from-learnings" "missing Learned Patterns section" "$tmpdir/AGENTS.md" "$tmpdir"
  fi
  if ! grep -q '^- Note: Keep path confinement checks before writes$' "$tmpdir/AGENTS.md"; then
    fail_case "sync-agents-from-learnings" "missing synced note entry" "$tmpdir/AGENTS.md" "$tmpdir"
  fi

  set +e
  "$SYNC_SCRIPT" --root "$tmpdir" > "$tmpdir/out2.log" 2>&1
  rc=$?
  set -e
  if [[ "$rc" -ne 0 ]]; then
    fail_case "sync-agents-from-learnings" "expected second sync success, got rc=$rc" "$tmpdir/out2.log" "$tmpdir"
  fi
  if [[ "$(grep -c '^- Note: Keep path confinement checks before writes$' "$tmpdir/AGENTS.md")" -ne 1 ]]; then
    fail_case "sync-agents-from-learnings" "note should not be duplicated" "$tmpdir/AGENTS.md" "$tmpdir"
  fi

  cleanup_dir "$tmpdir"
  printf 'PASS [sync-agents-from-learnings]\n'
}

run_case
printf 'All AGENTS sync tests passed.\n'
