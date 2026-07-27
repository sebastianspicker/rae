#!/usr/bin/env bash
# Regression coverage for Ralph's supervisor contract.

set -euo pipefail

# shellcheck source=tests/lib/test_helpers.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/test_helpers.sh"

require_cmds python3 mktemp
supervisor="$ROOT_DIR/scripts/ralph_supervisor.py"
tmpdir="$(mktemp -d)"

cat >"$tmpdir/success.sh" <<'EOF'
#!/usr/bin/env bash
printf 'raw\n'
printf '# report\n' >"$1"
EOF
chmod +x "$tmpdir/success.sh"
python3 "$supervisor" --timeout 5 --grace 1 --raw-output "$tmpdir/raw" \
  --report "$tmpdir/report" -- "$tmpdir/success.sh" "$tmpdir/report"
grep -q '^raw$' "$tmpdir/raw"
grep -q '^# report$' "$tmpdir/report"

set +e
python3 "$supervisor" --timeout 1 --grace 1 --raw-output "$tmpdir/timeout.raw" \
  --report "$tmpdir/timeout.report" -- /bin/sh -c 'trap "" INT; sleep 10'
rc=$?
set -e
[[ "$rc" -eq 124 ]] || fail_case "supervisor-timeout" "expected 124, got $rc" "" "$tmpdir"

set +e
# shellcheck disable=SC2016
python3 "$supervisor" --timeout 5 --grace 1 --raw-output "$tmpdir/overflow.raw" \
  --report "$tmpdir/overflow.report" --raw-limit 64 -- /bin/sh -c \
  'i=0; while [ "$i" -lt 200 ]; do printf x; i=$((i+1)); done'
rc=$?
set -e
[[ "$rc" -eq 125 ]] || fail_case "supervisor-raw-overflow" "expected 125, got $rc" "" "$tmpdir"
[[ "$(wc -c <"$tmpdir/overflow.raw" | tr -d ' ')" -eq 64 ]] \
  || fail_case "supervisor-raw-overflow" "raw file exceeded limit" "" "$tmpdir"

set +e
# shellcheck disable=SC2016
python3 "$supervisor" --timeout 5 --grace 1 --raw-output "$tmpdir/report-overflow.raw" \
  --report "$tmpdir/report-overflow" --report-limit 64 -- /bin/sh -c \
  'i=0; : >"$1"; while [ "$i" -lt 200 ]; do printf x >>"$1"; i=$((i+1)); done' \
  sh "$tmpdir/report-overflow"
rc=$?
set -e
[[ "$rc" -eq 125 ]] || fail_case "supervisor-report-overflow" "expected 125, got $rc" "" "$tmpdir"

cleanup_dir "$tmpdir"
printf 'PASS [supervisor]\n'
