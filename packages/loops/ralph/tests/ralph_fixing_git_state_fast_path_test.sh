#!/usr/bin/env bash

set -euo pipefail

# shellcheck source=tests/lib/test_helpers.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/test_helpers.sh"

require_cmds jq mktemp git

make_fake_tool() {
  local fake_tool="$1"
  cat > "$fake_tool" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
cat >/dev/null

mkdir -p src
printf 'changed\n' > src/outside.txt
printf '# fake report\n'
EOF
  chmod +x "$fake_tool"
}

prepare_repo() {
  local repo_dir="$1"
  prepare_runner_and_tool "$repo_dir"

  cat > "$repo_dir/prd.json" <<'EOF'
{
  "schema_version": "1.0.0",
  "project": "fixing-git-fast-path-test",
  "defaults": {
    "mode_default": "fixing",
    "max_stories_default": "all_open",
    "model_default": "gpt-5.3",
    "reasoning_effort_default": "high",
    "report_dir": "audit",
    "sandbox_by_mode": {
      "audit": "read-only",
      "linting": "read-only",
      "fixing": "workspace-write"
    },
    "lint_detection_order": [
      "package.json scripts (lint/test)"
    ]
  },
  "stories": [
    {
      "id": "FIX-001",
      "title": "Fast path scope",
      "priority": 1,
      "mode": "fixing",
      "scope": ["docs/**"],
      "acceptance_criteria": [
        "Created audit/FIX-001.md with report"
      ],
      "passes": false
    }
  ]
}
EOF

  mkdir -p "$repo_dir/docs" "$repo_dir/src"
  printf 'base\n' > "$repo_dir/docs/allowed.md"
  printf 'base\n' > "$repo_dir/src/outside.txt"

  (
    cd "$repo_dir"
    git init -q
    git config user.email "test@example.com"
    git config user.name "Test User"
    git add .
    git commit -q -m "fixture"
  )
}

can_write_git_hooks() {
  local d r
  d="$(mktemp -d)"
  ( cd "$d" && git init -q && : > .git/hooks/.keep ) 2>/dev/null
  r=$?
  rm -rf "$d"
  return "$r"
}

run_case() {
  local tmpdir bindir rc events_log
  if ! can_write_git_hooks; then
    printf 'SKIP [fixing-git-fast-path]: .git/hooks not writable (sandbox)\n'
    return 0
  fi
  tmpdir="$(mktemp -d)"
  bindir="$tmpdir/bin"
  mkdir -p "$bindir" "$tmpdir/repo"

  make_fake_tool "$bindir/claude"
  prepare_repo "$tmpdir/repo"

  set +e
  (
    cd "$tmpdir/repo"
    PATH="$bindir:$PATH" MODE=fixing RALPH_FIXING_STATE_METHOD=auto ./ralph.sh 1
  ) > "$tmpdir/out.log" 2>&1
  rc=$?
  set -e

  if [[ "$rc" -eq 0 ]]; then
    fail_case "fixing-git-fast-path" "expected scope failure, got success" "$tmpdir/out.log" "$tmpdir"
  fi
  if ! grep -q 'modified files outside scope' "$tmpdir/out.log"; then
    fail_case "fixing-git-fast-path" "missing scope violation message" "$tmpdir/out.log" "$tmpdir"
  fi
  if ! grep -q 'src/outside.txt' "$tmpdir/out.log"; then
    fail_case "fixing-git-fast-path" "missing out-of-scope path in error output" "$tmpdir/out.log" "$tmpdir"
  fi

  events_log="$tmpdir/repo/.runtime/events.log"
  if [[ ! -f "$events_log" ]]; then
    fail_case "fixing-git-fast-path" "missing events log" "$tmpdir/out.log" "$tmpdir"
  fi
  if ! grep -q 'fixing_state_method=git' "$events_log"; then
    fail_case "fixing-git-fast-path" "git fast-path method was not used/logged" "$tmpdir/out.log" "$tmpdir"
  fi

  cleanup_dir "$tmpdir"
  printf 'PASS [fixing-git-fast-path]\n'
}

run_case
printf 'All fixing git fast-path tests passed.\n'
