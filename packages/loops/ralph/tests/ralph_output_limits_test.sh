#!/usr/bin/env bash
# Regression coverage for Ralph's output limits contract.

set -euo pipefail

# shellcheck source=tests/lib/test_helpers.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/test_helpers.sh"

require_cmds jq mktemp
tmpdir="$(mktemp -d)"
mkdir -p "$tmpdir/bin" "$tmpdir/repo"
prepare_runner_and_tool "$tmpdir/repo"

cat >"$tmpdir/bin/codex" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
output=""
for ((i=1; i<=$#; i++)); do
  if [[ "${!i}" == "--output-last-message" ]]; then
    j=$((i + 1))
    output="${!j}"
  fi
done
cat >/dev/null
dd if=/dev/zero of="$output" bs=1048576 count=3 2>/dev/null
EOF
chmod +x "$tmpdir/bin/codex"

jq '.defaults.report_dir = "audit" | .stories = [{
  id:"AUDIT-001",title:"Oversized report",priority:1,mode:"audit",scope:["**/*"],
  acceptance_criteria:["Created audit/AUDIT-001.md with report"],passes:false
}]' "$PRD_FILE" >"$tmpdir/repo/prd.json"

set +e
(cd "$tmpdir/repo" && PATH="$tmpdir/bin:$PATH" MODE=audit ./ralph.sh 1) >"$tmpdir/out.log" 2>&1
rc=$?
set -e
[[ "$rc" -eq 4 ]] \
  || fail_case "report-overflow-exit" "expected Ralph exit 4, got $rc" "$tmpdir/out.log" "$tmpdir"
jq -e '.stories[0].passes == false and (.stories[0].report_path? == null)' "$tmpdir/repo/prd.json" >/dev/null \
  || fail_case "report-overflow-persistence" "oversized report persisted success" "$tmpdir/out.log" "$tmpdir"
[[ ! -e "$tmpdir/repo/audit/AUDIT-001.md" ]] \
  || fail_case "report-overflow-persistence" "oversized final report was written" "$tmpdir/out.log" "$tmpdir"
grep -q 'codex_output_overflow' "$tmpdir/repo/.runtime/events.log" \
  || fail_case "report-overflow-event" "overflow event missing" "$tmpdir/out.log" "$tmpdir"

cleanup_dir "$tmpdir"
printf 'PASS [output-limits]\n'
