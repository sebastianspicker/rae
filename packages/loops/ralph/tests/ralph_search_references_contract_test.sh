#!/usr/bin/env bash
# Verifies that search-enabled reports retain the required dated external references.

set -euo pipefail

# shellcheck source=tests/lib/test_helpers.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/test_helpers.sh"

require_cmds mktemp

make_fake_tool() {
  local fake_tool="$1"
  cat > "$fake_tool" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

last_message=""
repo=""
for ((ralph_i=1; ralph_i<=$#; ralph_i++)); do
  ralph_arg="${!ralph_i}"
  if [[ "$ralph_arg" == "--output-last-message" ]]; then
    ralph_j=$((ralph_i + 1))
    last_message="${!ralph_j}"
  elif [[ "$ralph_arg" == "-C" ]]; then
    ralph_j=$((ralph_i + 1))
    repo="${!ralph_j}"
  fi
done
[[ -z "$repo" ]] || cd "$repo"
[[ -z "$last_message" ]] || exec >"$last_message"
cat >/dev/null

if [[ "${XDG_CONFIG_HOME:-false}" == "true" ]]; then
  cat <<'REPORT'
# Search Report

## Findings
- External claim with source evidence.

## External References
- [Reference](https://example.com/reference) (accessed: 2026-02-17)
REPORT
else
  cat <<'REPORT'
# Search Report

## Findings
- External claim without explicit references section.
REPORT
fi
EOF
  chmod +x "$fake_tool"
}

prepare_repo() {
  local repo_dir="$1"
  prepare_runner_and_tool "$repo_dir"
  cat > "$repo_dir/prd.json" <<'EOF'
{
  "schema_version": "1.0.0",
  "project": "search-references-contract-test",
  "defaults": {
    "mode_default": "audit",
    "max_stories_default": "all_open",
    "model_default": "gpt-5.3",
    "reasoning_effort_default": "high",
    "report_dir": ".claude/ralph-audit/audit",
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
      "title": "Search References Contract",
      "priority": 1,
      "mode": "audit",
      "scope": ["**/*"],
      "acceptance_criteria": [
        "Created .claude/ralph-audit/audit/AUDIT-001.md with report"
      ],
      "passes": false
    }
  ]
}
EOF
}

run_missing_refs_case() {
  local tmpdir bindir rc
  tmpdir="$(mktemp -d)"
  bindir="$tmpdir/bin"
  mkdir -p "$bindir" "$tmpdir/repo"
  make_fake_tool "$bindir/codex"
  prepare_repo "$tmpdir/repo"

  set +e
  (
    cd "$tmpdir/repo"
    PATH="$bindir:$PATH" \
    XDG_CONFIG_HOME=false \
    ./ralph.sh --search 1
  ) > "$tmpdir/out.log" 2>&1
  rc=$?
  set -e
  if [[ "$rc" -eq 0 ]]; then
    fail_case "search-refs-missing" "expected failure when search references are missing" "$tmpdir/out.log" "$tmpdir"
  fi
  if ! grep -q 'Codex exec failed for story AUDIT-001' "$tmpdir/out.log"; then
    fail_case "search-refs-missing" "expected Codex failure path for missing references contract" "$tmpdir/out.log" "$tmpdir"
  fi

  cleanup_dir "$tmpdir"
  printf 'PASS [search-refs-missing]\n'
}

run_with_refs_case() {
  local tmpdir bindir rc
  tmpdir="$(mktemp -d)"
  bindir="$tmpdir/bin"
  mkdir -p "$bindir" "$tmpdir/repo"
  make_fake_tool "$bindir/codex"
  prepare_repo "$tmpdir/repo"

  set +e
  (
    cd "$tmpdir/repo"
    PATH="$bindir:$PATH" \
    XDG_CONFIG_HOME=true \
    ./ralph.sh --search 1
  ) > "$tmpdir/out.log" 2>&1
  rc=$?
  set -e
  if [[ "$rc" -ne 0 ]]; then
    fail_case "search-refs-present" "expected success when references contract is satisfied" "$tmpdir/out.log" "$tmpdir"
  fi

  cleanup_dir "$tmpdir"
  printf 'PASS [search-refs-present]\n'
}

run_missing_refs_case
run_with_refs_case
printf 'All search references contract tests passed.\n'
