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

printf 'changed\n' >> .env
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
  "project": "fixing-git-mode-ignored-guard-test",
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
      "title": "Guard forced git mode",
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

  mkdir -p "$repo_dir/docs"
  printf 'base\n' > "$repo_dir/docs/allowed.md"
  printf 'secret\n' > "$repo_dir/.env"
  printf '.env\n' > "$repo_dir/.gitignore"

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
  local tmpdir bindir rc
  if ! can_write_git_hooks; then
    printf 'SKIP [git-mode-ignored-guard]: .git/hooks not writable (sandbox)\n'
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
    PATH="$bindir:$PATH" MODE=fixing RALPH_FIXING_STATE_METHOD=git ./ralph.sh 1
  ) > "$tmpdir/out.log" 2>&1
  rc=$?
  set -e

  if [[ "$rc" -eq 0 ]]; then
    fail_case "git-mode-ignored-guard" "expected failure, got success" "$tmpdir/out.log" "$tmpdir"
  fi
  if ! grep -q 'unsafe with ignored paths' "$tmpdir/out.log"; then
    fail_case "git-mode-ignored-guard" "missing guardrail error message for forced git mode" "$tmpdir/out.log" "$tmpdir"
  fi

  cleanup_dir "$tmpdir"
  printf 'PASS [git-mode-ignored-guard]\n'
}

run_case
printf 'All fixing git-mode ignored guard tests passed.\n'
