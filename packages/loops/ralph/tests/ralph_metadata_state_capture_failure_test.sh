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
cat >/dev/null

mkdir -p docs
printf 'tool-ran\n' >> docs/tool-ran.txt
printf '# fake report\n'
EOF
  chmod +x "$fake_tool"
}

make_failing_signature_stat() {
  local fake_stat="$1"
  cat > "$fake_stat" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

# Allow flavor detection via GNU probe.
if [[ "${1:-}" == "-c" && "${2:-}" == "%Y" ]]; then
  printf '0\n'
  exit 0
fi

# Force metadata signature collection to fail.
if [[ "${1:-}" == "-c" && "${2:-}" == "%Y:%Z:%s" ]]; then
  exit 1
fi

if [[ "${1:-}" == "-f" ]]; then
  exit 1
fi

exit 1
EOF
  chmod +x "$fake_stat"
}

prepare_repo() {
  local repo_dir="$1"
  prepare_runner_and_tool "$repo_dir"

  cat > "$repo_dir/prd.json" <<'EOF'
{
  "schema_version": "1.0.0",
  "project": "metadata-state-capture-failure-test",
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
      "title": "Metadata capture failure handling",
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
}

run_case() {
  local tmpdir bindir rc out passes
  tmpdir="$(mktemp -d)"
  bindir="$tmpdir/bin"
  mkdir -p "$bindir" "$tmpdir/repo"

  make_fake_tool "$bindir/claude"
  make_failing_signature_stat "$bindir/stat"
  prepare_repo "$tmpdir/repo"

  set +e
  (
    cd "$tmpdir/repo"
    PATH="$bindir:$PATH" MODE=fixing ./ralph.sh 1
  ) > "$tmpdir/out.log" 2>&1
  rc=$?
  set -e

  out="$(cat "$tmpdir/out.log")"
  if [[ "$rc" -eq 0 ]]; then
    fail_case "metadata-state-capture-failure" "expected failure when state metadata cannot be read" "$tmpdir/out.log" "$tmpdir"
  fi
  if ! printf '%s' "$out" | grep -q 'Could not read file metadata for:'; then
    fail_case "metadata-state-capture-failure" "expected explicit metadata failure message" "$tmpdir/out.log" "$tmpdir"
  fi
  if printf '%s' "$out" | grep -q '<promise>COMPLETE</promise>'; then
    fail_case "metadata-state-capture-failure" "run must not emit COMPLETE on metadata failure" "$tmpdir/out.log" "$tmpdir"
  fi

  passes="$(jq -r '.stories[0].passes' "$tmpdir/repo/prd.json")"
  if [[ "$passes" != "false" ]]; then
    fail_case "metadata-state-capture-failure" "story must remain open after metadata capture failure" "$tmpdir/repo/prd.json" "$tmpdir"
  fi
  if [[ -f "$tmpdir/repo/audit/FIX-001.md" ]]; then
    fail_case "metadata-state-capture-failure" "report must not be written on metadata capture failure" "$tmpdir/out.log" "$tmpdir"
  fi

  cleanup_dir "$tmpdir"
  printf 'PASS [metadata-state-capture-failure]\n'
}

run_case
printf 'All metadata state capture failure tests passed.\n'
