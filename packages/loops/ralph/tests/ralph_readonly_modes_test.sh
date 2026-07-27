#!/usr/bin/env bash
# Regression coverage for Ralph's readonly modes contract.

set -euo pipefail

# shellcheck source=tests/lib/test_helpers.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/test_helpers.sh"

make_fake_codex() {
  local path="$1"
  cat >"$path" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
output=""
sandbox=""
for ((i=1; i<=$#; i++)); do
  case "${!i}" in
    --output-last-message) j=$((i + 1)); output="${!j}" ;;
    -s) j=$((i + 1)); sandbox="${!j}" ;;
  esac
done
[[ "$sandbox" == "read-only" ]] || exit 42
cat >/dev/null
printf '# read-only report\n' >"$output"
EOF
  chmod +x "$path"
}

for mode in audit linting; do
  if [[ "$mode" == "audit" ]]; then
    story_id="AUDIT-001"
  else
    story_id="LINT-001"
  fi
  tmpdir="$(mktemp -d)"
  mkdir -p "$tmpdir/bin" "$tmpdir/repo"
  prepare_runner_and_tool "$tmpdir/repo"
  make_fake_codex "$tmpdir/bin/codex"
  jq --arg mode "$mode" --arg id "$story_id" '.defaults.report_dir = "audit" | .defaults.mode_default = $mode |
    .stories = [{id:$id,title:"Read only",priority:1,mode:$mode,scope:["**/*"],
      acceptance_criteria:[("Created audit/" + $id + ".md with report")],passes:false}]' \
    "$PRD_FILE" >"$tmpdir/repo/prd.json"
  if ! (cd "$tmpdir/repo" && PATH="$tmpdir/bin:$PATH" MODE="$mode" ./ralph.sh 1) >"$tmpdir/out.log" 2>&1; then
    fail_case "readonly-$mode" "Codex did not receive read-only sandbox" "$tmpdir/out.log" "$tmpdir"
  fi
  cleanup_dir "$tmpdir"
  printf 'PASS [readonly-%s]\n' "$mode"
done
