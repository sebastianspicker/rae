#!/usr/bin/env bash
# shellcheck disable=SC2016
# Regression coverage for Ralph's progress autorefresh contract.

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
cat >/dev/null
printf '# fake report\n'
EOF
  chmod +x "$fake_tool"
}

prepare_repo() {
  local repo_dir="$1"
  prepare_fixture "$repo_dir"

  mkdir -p "$repo_dir/scripts/lib"
  cp "$ROOT_DIR/scripts/generate_progress.sh" "$repo_dir/scripts/generate_progress.sh"
  cp "$ROOT_DIR/scripts/lib/prd_counts.sh" "$repo_dir/scripts/lib/prd_counts.sh"
  chmod +x "$repo_dir/scripts/generate_progress.sh"
  "$repo_dir/scripts/generate_progress.sh" "$repo_dir/prd.json" "$repo_dir/progress.txt"
}

run_case() {
  local tmpdir bindir rc total_stories
  tmpdir="$(mktemp -d)"
  bindir="$tmpdir/bin"
  mkdir -p "$bindir" "$tmpdir/repo"

  make_fake_tool "$bindir/codex"
  prepare_repo "$tmpdir/repo"
  total_stories="$(jq '.stories | length' "$tmpdir/repo/prd.json")"

  if ! grep -q "Stories passed: \`0/$total_stories\`" "$tmpdir/repo/progress.txt"; then
    fail_case "progress-autorefresh" "unexpected initial progress snapshot" "$tmpdir/repo/progress.txt" "$tmpdir"
  fi

  set +e
  (
    cd "$tmpdir/repo"
    PATH="$bindir:$PATH" MODE=audit ./ralph.sh 1
  ) > "$tmpdir/out.log" 2>&1
  rc=$?
  set -e

  if [[ "$rc" -ne 0 ]]; then
    fail_case "progress-autorefresh" "expected success, got rc=$rc" "$tmpdir/out.log" "$tmpdir"
  fi
  if ! grep -q "Stories passed: \`1/$total_stories\`" "$tmpdir/repo/progress.txt"; then
    fail_case "progress-autorefresh" "progress snapshot was not auto-refreshed after story completion" "$tmpdir/repo/progress.txt" "$tmpdir"
  fi

  cleanup_dir "$tmpdir"
  printf 'PASS [progress-autorefresh]\n'
}

run_case
printf 'All progress auto-refresh tests passed.\n'
