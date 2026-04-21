#!/usr/bin/env bash

set -euo pipefail

# shellcheck source=tests/lib/test_helpers.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/test_helpers.sh"

require_cmds jq mktemp ln

make_fake_tool() {
  local fake_tool="$1"
  cat > "$fake_tool" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
cat >/dev/null
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
  "project": "report-path-confinement-test",
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
      "title": "Report path confinement",
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
  mkdir -p "$bindir" "$tmpdir/repo" "$tmpdir/outside"

  make_fake_tool "$bindir/claude"
  prepare_repo "$tmpdir/repo"

  ln -s "$tmpdir/outside" "$tmpdir/repo/audit"

  set +e
  (
    cd "$tmpdir/repo"
    PATH="$bindir:$PATH" MODE=audit ./ralph.sh 1
  ) > "$tmpdir/out.log" 2>&1
  rc=$?
  set -e

  if [[ "$rc" -eq 0 ]]; then
    fail_case "report-path-symlink-escape" "expected failure for symlink escape, got success" "$tmpdir/out.log" "$tmpdir"
  fi
  if ! grep -q 'resolves outside repository' "$tmpdir/out.log"; then
    fail_case "report-path-symlink-escape" "missing confinement error message" "$tmpdir/out.log" "$tmpdir"
  fi

  cleanup_dir "$tmpdir"
  printf 'PASS [report-path-symlink-escape]\n'
}

run_case
printf 'All report path confinement tests passed.\n'
