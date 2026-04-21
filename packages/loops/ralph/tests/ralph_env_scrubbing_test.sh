#!/usr/bin/env bash

set -euo pipefail

# shellcheck source=tests/lib/test_helpers.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/test_helpers.sh"

require_cmds mktemp jq

make_fake_claude() {
  local fake_tool="$1"
  cat >"$fake_tool" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

cat >/dev/null

if [[ -n "${AWS_SESSION_TOKEN:-}" ]]; then
  printf 'unexpected inherited secret env\n' >&2
  exit 21
fi
if [[ -z "${FAKE_STATE_FILE:-}" ]]; then
  printf 'missing allowed fake env\n' >&2
  exit 22
fi

printf 'scrubbed\n' >"$FAKE_STATE_FILE"
printf '# fake report\n'
EOF
  chmod +x "$fake_tool"
}

prepare_repo() {
  local repo_dir="$1"
  prepare_runner_and_tool "$repo_dir"

  cat >"$repo_dir/prd.json" <<'EOF'
{
  "schema_version": "1.0.0",
  "project": "env-scrubbing-test",
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
      "id": "AUDIT-001",
      "title": "Env scrubbing",
      "priority": 1,
      "mode": "audit",
      "scope": ["**/*"],
      "acceptance_criteria": [
        "Created audit/AUDIT-001.md with report"
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

  make_fake_claude "$bindir/claude"
  prepare_repo "$tmpdir/repo"

  set +e
  (
    cd "$tmpdir/repo"
    PATH="$bindir:$PATH" \
      MODE=audit \
      AWS_SESSION_TOKEN="should-not-leak" \
      FAKE_STATE_FILE="$tmpdir/seen.txt" \
      ./ralph.sh 1
  ) >"$tmpdir/out.log" 2>&1
  rc=$?
  set -e

  if [[ "$rc" -ne 0 ]]; then
    fail_case "env-scrubbing" "expected success, got rc=$rc" "$tmpdir/out.log" "$tmpdir"
  fi
  if [[ ! -f "$tmpdir/seen.txt" ]]; then
    fail_case "env-scrubbing" "expected fake tool to receive allowlisted env" "$tmpdir/out.log" "$tmpdir"
  fi
  if grep -q 'unexpected inherited secret env' "$tmpdir/out.log"; then
    fail_case "env-scrubbing" "tool inherited non-allowlisted secret env" "$tmpdir/out.log" "$tmpdir"
  fi

  cleanup_dir "$tmpdir"
  printf 'PASS [env-scrubbing]\n'
}

run_case
printf 'All env scrubbing tests passed.\n'
