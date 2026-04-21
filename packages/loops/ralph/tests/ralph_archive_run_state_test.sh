#!/usr/bin/env bash

set -euo pipefail

# shellcheck source=tests/lib/test_helpers.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/test_helpers.sh"

require_cmds mktemp jq grep

ARCHIVE_SCRIPT="$ROOT_DIR/scripts/archive_run_state.sh"

prepare_fixture_repo() {
  local repo="$1"
  mkdir -p "$repo/.claude/ralph-audit/audit"
  cp "$PRD_FILE" "$repo/prd.json"
  cat > "$repo/progress.txt" <<'EOF'
# Ralph Audit Progress (Generated)
EOF
  cp "$ROOT_DIR/learnings.md" "$repo/learnings.md"
  printf '# sample report\n' > "$repo/.claude/ralph-audit/audit/sample.md"
  printf 'legacy\n' > "$repo/.claude/ralph-audit/audit/legacy.txt"
}

run_archive_case() {
  local tmpdir repo archive_root rc archive_dir
  tmpdir="$(mktemp -d)"
  repo="$tmpdir/repo"
  archive_root="$tmpdir/archive"
  mkdir -p "$repo"
  prepare_fixture_repo "$repo"

  set +e
  "$ARCHIVE_SCRIPT" --source-root "$repo" --archive-root "$archive_root" --label "feature-x" --reason "before-reset" > "$tmpdir/out.log" 2>&1
  rc=$?
  set -e
  if [[ "$rc" -ne 0 ]]; then
    fail_case "archive-run-state" "expected success, got rc=$rc" "$tmpdir/out.log" "$tmpdir"
  fi

  archive_dir="$(find "$archive_root" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
  if [[ -z "$archive_dir" ]]; then
    fail_case "archive-run-state" "expected archive directory to be created" "$tmpdir/out.log" "$tmpdir"
  fi

  if [[ ! -f "$archive_dir/prd.json" ]]; then
    fail_case "archive-run-state" "missing archived prd.json" "$tmpdir/out.log" "$tmpdir"
  fi
  if [[ ! -f "$archive_dir/progress.txt" ]]; then
    fail_case "archive-run-state" "missing archived progress.txt" "$tmpdir/out.log" "$tmpdir"
  fi
  if [[ ! -f "$archive_dir/learnings.md" ]]; then
    fail_case "archive-run-state" "missing archived learnings.md" "$tmpdir/out.log" "$tmpdir"
  fi
  if [[ ! -f "$archive_dir/.claude/ralph-audit/audit/sample.md" ]]; then
    fail_case "archive-run-state" "missing archived report directory content" "$tmpdir/out.log" "$tmpdir"
  fi
  if [[ ! -f "$archive_dir/archive.meta" ]]; then
    fail_case "archive-run-state" "missing archive.meta" "$tmpdir/out.log" "$tmpdir"
  fi
  if ! grep -q '^reason=before-reset$' "$archive_dir/archive.meta"; then
    fail_case "archive-run-state" "expected reason in archive.meta" "$archive_dir/archive.meta" "$tmpdir"
  fi

  cleanup_dir "$tmpdir"
  printf 'PASS [archive-run-state]\n'
}

run_archive_case

run_force_overwrite_case() {
  local tmpdir repo archive_root bindir rc archive_dir
  local real_date
  tmpdir="$(mktemp -d)"
  repo="$tmpdir/repo"
  archive_root="$tmpdir/archive"
  bindir="$tmpdir/bin"
  mkdir -p "$repo" "$bindir"
  prepare_fixture_repo "$repo"

  real_date="$(command -v date)"
  cat > "$bindir/date" <<EOF
#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == "-u" ]]; then
  shift
fi
case "\${1:-}" in
  +%Y%m%dT%H%M%SZ)
    printf '20260101T000000Z\\n'
    ;;
  +%Y-%m-%dT%H:%M:%SZ)
    printf '2026-01-01T00:00:00Z\\n'
    ;;
  *)
    exec "$real_date" "\$@"
    ;;
esac
EOF
  chmod +x "$bindir/date"

  set +e
  PATH="$bindir:$PATH" "$ARCHIVE_SCRIPT" --source-root "$repo" --archive-root "$archive_root" --label "feature-x" --reason "first" > "$tmpdir/first.log" 2>&1
  rc=$?
  set -e
  if [[ "$rc" -ne 0 ]]; then
    fail_case "archive-run-state-force" "first archive run failed rc=$rc" "$tmpdir/first.log" "$tmpdir"
  fi

  archive_dir="$archive_root/20260101T000000Z-feature-x"
  if [[ ! -f "$archive_dir/.claude/ralph-audit/audit/legacy.txt" ]]; then
    fail_case "archive-run-state-force" "expected legacy file in initial archive" "$tmpdir/first.log" "$tmpdir"
  fi

  rm -f "$repo/.claude/ralph-audit/audit/legacy.txt"
  printf 'fresh\n' > "$repo/.claude/ralph-audit/audit/fresh.txt"

  set +e
  PATH="$bindir:$PATH" "$ARCHIVE_SCRIPT" --source-root "$repo" --archive-root "$archive_root" --label "feature-x" --reason "second" --force > "$tmpdir/second.log" 2>&1
  rc=$?
  set -e
  if [[ "$rc" -ne 0 ]]; then
    fail_case "archive-run-state-force" "second archive run with --force failed rc=$rc" "$tmpdir/second.log" "$tmpdir"
  fi

  if [[ -f "$archive_dir/.claude/ralph-audit/audit/legacy.txt" ]]; then
    fail_case "archive-run-state-force" "legacy file should not survive forced overwrite" "$tmpdir/second.log" "$tmpdir"
  fi
  if [[ ! -f "$archive_dir/.claude/ralph-audit/audit/fresh.txt" ]]; then
    fail_case "archive-run-state-force" "fresh file missing after forced overwrite" "$tmpdir/second.log" "$tmpdir"
  fi

  cleanup_dir "$tmpdir"
  printf 'PASS [archive-run-state-force]\n'
}

run_force_overwrite_case
printf 'All archive run state tests passed.\n'
