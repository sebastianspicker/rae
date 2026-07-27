#!/usr/bin/env bash
# Regression coverage for Ralph's stat flavor probe contract.

set -euo pipefail

# shellcheck source=tests/lib/test_helpers.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/test_helpers.sh"

require_cmds jq mktemp

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

repo=""
for ((i=1; i<=$#; i++)); do
  arg="${!i}"
  if [[ "$arg" == "-C" ]]; then
    j=$((i + 1))
    repo="${!j}"
  fi
done

[[ -n "$repo" ]] && cd "$repo"

mkdir -p src
printf 'changed\n' >> src/outside.txt
cat >/dev/null
printf '# fake report\n'
EOF
  chmod +x "$fake_tool"
}

make_busybox_like_stat() {
  local fake_stat="$1"
  cat > "$fake_stat" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

# BusyBox-like behavior for this test:
# - no --version support
# - GNU-style -c format works
# - BSD-style -f format not supported
if [[ "${1:-}" == "--version" ]]; then
  printf 'stat: unrecognized option: --version\n' >&2
  exit 1
fi

if [[ "${1:-}" == "-c" ]]; then
  fmt="${2:-}"
  target="${3:-}"
  case "$fmt" in
    '%Y')
      printf '0\n'
      ;;
    '%Y:%Z:%s')
      size="$(wc -c < "$target" 2>/dev/null || printf '0')"
      printf '0:0:%s\n' "$size"
      ;;
    *)
      printf '0\n'
      ;;
  esac
  exit 0
fi

if [[ "${1:-}" == "-f" ]]; then
  printf 'stat: invalid option -- f\n' >&2
  exit 1
fi

printf 'unsupported fake stat call\n' >&2
exit 2
EOF
  chmod +x "$fake_stat"
}

prepare_repo() {
  local repo_dir="$1"
  prepare_runner_and_tool "$repo_dir"

  cat > "$repo_dir/prd.json" <<'EOF'
{
  "schema_version": "1.0.0",
  "project": "stat-flavor-probe-test",
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
      "title": "Stat probe scope check",
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
}

run_case() {
  local tmpdir bindir rc out
  tmpdir="$(mktemp -d)"
  bindir="$tmpdir/bin"
  mkdir -p "$bindir" "$tmpdir/repo"

  make_fake_tool "$bindir/codex"
  make_busybox_like_stat "$bindir/stat"
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
    fail_case "stat-flavor-probe" "expected failure for out-of-scope modification, got success" "$tmpdir/out.log" "$tmpdir"
  fi
  if ! printf '%s' "$out" | grep -q 'modified files outside scope'; then
    fail_case "stat-flavor-probe" "expected scope violation message (stat probe should select gnu -c path)" "$tmpdir/out.log" "$tmpdir"
  fi
  if ! printf '%s' "$out" | grep -q 'src/outside.txt'; then
    fail_case "stat-flavor-probe" "expected offending path in output" "$tmpdir/out.log" "$tmpdir"
  fi

  cleanup_dir "$tmpdir"
  printf 'PASS [stat-flavor-probe]\n'
}

run_case
printf 'All stat flavor probe tests passed.\n'
