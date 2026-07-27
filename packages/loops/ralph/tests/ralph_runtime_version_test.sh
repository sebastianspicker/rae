#!/usr/bin/env bash
# Regression coverage for Ralph's runtime version contract.

set -euo pipefail

# shellcheck source=tests/lib/test_helpers.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/test_helpers.sh"

tmpdir="$(mktemp -d)"
mkdir -p "$tmpdir/bin"
cat >"$tmpdir/bin/python3" <<'EOF'
#!/bin/sh
exit 1
EOF
chmod +x "$tmpdir/bin/python3"

set +e
PATH="$tmpdir/bin:/usr/bin:/bin" "$BASH" "$RUNNER" --version >"$tmpdir/out.log" 2>&1
rc=$?
set -e
[[ "$rc" -ne 0 ]] \
  || fail_case "python-version-floor" "unsupported Python unexpectedly succeeded" "$tmpdir/out.log" "$tmpdir"
grep -q 'Python >= 3.14.6 is required' "$tmpdir/out.log" \
  || fail_case "python-version-floor" "missing Python floor diagnostic" "$tmpdir/out.log" "$tmpdir"

cleanup_dir "$tmpdir"
printf 'PASS [runtime-version-floor]\n'
