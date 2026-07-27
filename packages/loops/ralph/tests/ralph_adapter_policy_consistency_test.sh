#!/usr/bin/env bash
# Regression coverage for Ralph's adapter policy consistency contract.

set -euo pipefail

# shellcheck source=tests/lib/test_helpers.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/test_helpers.sh"

require_cmds mktemp

make_fake_codex() {
  local path="$1"
  cat >"$path" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
output=""
for ((i=1; i<=$#; i++)); do
  if [[ "${!i}" == "--output-last-message" ]]; then
    j=$((i + 1))
    output="${!j}"
  fi
done
prompt="$(cat)"
[[ "$prompt" == *"IMMUTABLE_POLICY_MARKER"* ]] || exit 41
printf '# fake report\n' >"$output"
EOF
  chmod +x "$path"
}

tmpdir="$(mktemp -d)"
mkdir -p "$tmpdir/bin" "$tmpdir/repo"
prepare_runner_and_tool "$tmpdir/repo"
make_fake_codex "$tmpdir/bin/codex"
printf 'IMMUTABLE_POLICY_MARKER\n' >"$tmpdir/repo/INSTRUCTIONS.md"
jq '.defaults.report_dir = "audit" | .defaults.max_stories_default = 1 | .stories = [{
  id: "AUDIT-001", title: "Policy", priority: 1, mode: "audit",
  scope: ["**/*"], acceptance_criteria: ["Created audit/AUDIT-001.md with report"],
  passes: false
}]' "$PRD_FILE" >"$tmpdir/repo/prd.json"

if ! (cd "$tmpdir/repo" && PATH="$tmpdir/bin:$PATH" MODE=audit ./ralph.sh 1) >"$tmpdir/out.log" 2>&1; then
  fail_case "codex-policy" "Codex prompt did not preserve INSTRUCTIONS.md" "$tmpdir/out.log" "$tmpdir"
fi
cleanup_dir "$tmpdir"
printf 'PASS [codex-policy]\n'
