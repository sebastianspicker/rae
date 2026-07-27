#!/usr/bin/env bash
# Regression coverage for Ralph's env scrubbing contract.

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

cat >/dev/null

if [[ -n "${AWS_SESSION_TOKEN:-}" ]]; then
  printf 'unexpected inherited secret env\n' >&2
  exit 21
fi
if [[ -n "${FAKE_SHOULD_NOT_LEAK:-}" || -n "${CODEX_SHOULD_NOT_LEAK:-}" ]]; then
  printf 'unexpected inherited non-allowlisted env\n' >&2
  exit 23
fi
if [[ "${CODEX_INTERNAL_ORIGINATOR_OVERRIDE:-}" != "codex_cli_rs" ]]; then
  printf 'originator override was not fixed\n' >&2
  exit 24
fi
if [[ "$PWD" != "$repo" ]]; then
  printf 'PWD was not set to repository root\n' >&2
  exit 25
fi
if [[ -z "${XDG_STATE_HOME:-}" ]]; then
  printf 'missing allowed fake env\n' >&2
  exit 22
fi

printf 'scrubbed\n' >"$XDG_STATE_HOME"
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

  make_fake_codex "$bindir/codex"
  prepare_repo "$tmpdir/repo"

  set +e
  (
    cd "$tmpdir/repo"
    PATH="$bindir:$PATH" \
      MODE=audit \
      AWS_SESSION_TOKEN="should-not-leak" \
      FAKE_SHOULD_NOT_LEAK="no" \
      CODEX_SHOULD_NOT_LEAK="no" \
      CODEX_INTERNAL_ORIGINATOR_OVERRIDE="untrusted" \
      XDG_STATE_HOME="$tmpdir/seen.txt" \
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
