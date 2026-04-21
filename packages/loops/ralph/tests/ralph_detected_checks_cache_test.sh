#!/usr/bin/env bash

set -euo pipefail

# shellcheck source=tests/lib/test_helpers.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/test_helpers.sh"

require_cmds jq mktemp

make_fake_tool() {
  local fake_tool="$1"
  cat > "$fake_tool" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

: "${FAKE_STATE_FILE:?missing FAKE_STATE_FILE}"

prompt="$(cat)"
if [[ ! -f "$FAKE_STATE_FILE" ]]; then
  if printf '%s' "$prompt" | grep -q 'npm run lint'; then
    printf 'unexpected lint command in first fixing prompt\n' >&2
    exit 11
  fi

  cat > package.json <<'JSON'
{
  "name": "cache-refresh-test",
  "version": "1.0.0",
  "scripts": {
    "lint": "echo lint"
  }
}
JSON
  printf 'first-call-done\n' > "$FAKE_STATE_FILE"
else
  if ! printf '%s' "$prompt" | grep -q 'npm run lint'; then
    printf 'missing refreshed lint command in second fixing prompt\n' >&2
    exit 12
  fi
fi

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
  "project": "detected-check-cache-test",
  "defaults": {
    "mode_default": "audit",
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
      "title": "First fixing story",
      "priority": 1,
      "mode": "fixing",
      "scope": ["*", "**/*"],
      "acceptance_criteria": [
        "Created audit/FIX-001.md with report"
      ],
      "passes": false
    },
    {
      "id": "FIX-002",
      "title": "Second fixing story",
      "priority": 2,
      "mode": "fixing",
      "scope": ["*", "**/*"],
      "acceptance_criteria": [
        "Created audit/FIX-002.md with report"
      ],
      "passes": false
    }
  ]
}
EOF
}

run_case() {
  local tmpdir bindir rc
  tmpdir="$(mktemp -d)"
  bindir="$tmpdir/bin"
  mkdir -p "$bindir" "$tmpdir/repo"

  make_fake_tool "$bindir/claude"
  prepare_repo "$tmpdir/repo"

  set +e
  (
    cd "$tmpdir/repo"
    PATH="$bindir:$PATH" FAKE_STATE_FILE="$tmpdir/fake-state.txt" MODE=fixing ./ralph.sh 2
  ) > "$tmpdir/out.log" 2>&1
  rc=$?
  set -e

  if [[ "$rc" -ne 0 ]]; then
    fail_case "detected-check-cache-refresh" "expected success, got rc=$rc" "$tmpdir/out.log" "$tmpdir"
  fi

  cleanup_dir "$tmpdir"
  printf 'PASS [detected-check-cache-refresh]\n'
}

run_case
printf 'All detected-check cache tests passed.\n'
