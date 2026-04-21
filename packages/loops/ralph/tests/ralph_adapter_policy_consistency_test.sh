#!/usr/bin/env bash

set -euo pipefail

# shellcheck source=tests/lib/test_helpers.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/test_helpers.sh"

require_cmds mktemp

make_fake_claude() {
  local fake_tool="$1"
  cat >"$fake_tool" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
prompt="$(cat)"
if [[ "$prompt" != *"IMMUTABLE_POLICY_MARKER"* ]]; then
  printf 'policy marker missing from claude prompt\n' >&2
  exit 41
fi
printf '# fake report\n'
EOF
  chmod +x "$fake_tool"
}

make_fake_codex() {
  local fake_tool="$1"
  cat >"$fake_tool" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
output_file=""
for ((i=1; i<=$#; i++)); do
  arg="${!i}"
  if [[ "$arg" == "--output-last-message" || "$arg" == "-o" ]]; then
    j=$((i + 1))
    output_file="${!j}"
  fi
done

prompt="$(cat)"
if [[ "$prompt" != *"IMMUTABLE_POLICY_MARKER"* ]]; then
  printf 'policy marker missing from codex prompt\n' >&2
  exit 42
fi
[[ -n "$output_file" ]] || exit 43
printf '# fake report\n' >"$output_file"
EOF
  chmod +x "$fake_tool"
}

prepare_repo() {
  local repo_dir="$1"
  prepare_runner_and_tool "$repo_dir"

  cat >"$repo_dir/INSTRUCTIONS.md" <<'EOF'
IMMUTABLE_POLICY_MARKER
EOF

  cat >"$repo_dir/prd.json" <<'EOF'
{
  "schema_version": "1.0.0",
  "project": "adapter-policy-consistency-test",
  "defaults": {
    "mode_default": "audit",
    "max_stories_default": 1,
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
      "title": "Adapter policy consistency",
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
  local name="$1"
  local tool="$2"
  local tmpdir bindir rc
  tmpdir="$(mktemp -d)"
  bindir="$tmpdir/bin"
  mkdir -p "$bindir" "$tmpdir/repo"

  make_fake_claude "$bindir/claude"
  make_fake_codex "$bindir/codex"
  prepare_repo "$tmpdir/repo"

  set +e
  (
    cd "$tmpdir/repo"
    PATH="$bindir:$PATH" ./ralph.sh --tool "$tool" 1
  ) >"$tmpdir/out.log" 2>&1
  rc=$?
  set -e

  if [[ "$rc" -ne 0 ]]; then
    fail_case "$name" "expected success, got rc=$rc" "$tmpdir/out.log" "$tmpdir"
  fi

  cleanup_dir "$tmpdir"
  printf 'PASS [%s]\n' "$name"
}

run_case "adapter-policy-claude" "claude"
run_case "adapter-policy-codex" "codex"
printf 'All adapter policy consistency tests passed.\n'
