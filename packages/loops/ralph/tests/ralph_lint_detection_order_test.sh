#!/usr/bin/env bash
# Regression coverage for Ralph's lint detection order contract.

set -euo pipefail

# shellcheck source=tests/lib/test_helpers.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/test_helpers.sh"

require_cmds mktemp jq

make_fake_codex() {
  local fake_tool="$1"
  cat >"$fake_tool" <<'EOF'
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

prompt="$(cat)"
python_line="$(printf '%s\n' "$prompt" | grep -En 'command: (ruff check \.|python3 -m ruff check \.)' | head -n1 | cut -d: -f1 || true)"
package_line="$(printf '%s\n' "$prompt" | grep -n 'command: npm run lint' | head -n1 | cut -d: -f1 || true)"

if [[ -z "$python_line" || -z "$package_line" ]]; then
  printf 'missing expected check entries in prompt\n' >&2
  exit 31
fi
if [[ "$python_line" -ge "$package_line" ]]; then
  printf 'lint detection order not honored\n' >&2
  exit 32
fi

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
  "project": "lint-detection-order-test",
  "defaults": {
    "mode_default": "fixing",
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
      "pyproject/requirements (ruff/pytest)",
      "package.json scripts (lint/test)"
    ]
  },
  "stories": [
    {
      "id": "FIX-001",
      "title": "Ordered check detection",
      "priority": 1,
      "mode": "fixing",
      "scope": ["**/*"],
      "acceptance_criteria": [
        "Created audit/FIX-001.md with report"
      ],
      "passes": false
    }
  ]
}
EOF

  cat >"$repo_dir/package.json" <<'EOF'
{
  "name": "lint-order-test",
  "scripts": {
    "lint": "echo lint"
  }
}
EOF

  cat >"$repo_dir/pyproject.toml" <<'EOF'
[project]
name = "lint-order-test"
version = "0.1.0"
EOF
}

run_case() {
  local tmpdir bindir rc
  tmpdir="$(mktemp -d)"
  bindir="$tmpdir/bin"
  mkdir -p "$bindir" "$tmpdir/repo"

  make_fake_codex "$bindir/codex"
  prepare_repo "$tmpdir/repo"

  set +e
  (
    cd "$tmpdir/repo"
    PATH="$bindir:$PATH" MODE=fixing ./ralph.sh 1
  ) >"$tmpdir/out.log" 2>&1
  rc=$?
  set -e

  if [[ "$rc" -ne 0 ]]; then
    fail_case "lint-detection-order" "expected success, got rc=$rc" "$tmpdir/out.log" "$tmpdir"
  fi

  cleanup_dir "$tmpdir"
  printf 'PASS [lint-detection-order]\n'
}

run_case
printf 'All lint detection order tests passed.\n'
