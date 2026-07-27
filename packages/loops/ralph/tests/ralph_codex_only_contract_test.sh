#!/usr/bin/env bash
# Verifies that Ralph rejects legacy model backends and remains Codex-only.

set -euo pipefail

# shellcheck source=tests/lib/test_helpers.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/test_helpers.sh"

tmpdir="$(mktemp -d)"
mkdir -p "$tmpdir/repo"
prepare_fixture "$tmpdir/repo"

if ! (cd "$tmpdir/repo" && RALPH_TOOL=unsupported ./ralph.sh 0) >"$tmpdir/ignored.log" 2>&1; then
  fail_case "removed-tool-env" "removed RALPH_TOOL should not affect Codex-only runs" "$tmpdir/ignored.log" "$tmpdir"
fi
grep -q 'tool=codex' "$tmpdir/ignored.log" \
  || fail_case "removed-tool-env" "run should identify Codex" "$tmpdir/ignored.log" "$tmpdir"

if (cd "$tmpdir/repo" && ./ralph.sh --tool codex 0) >"$tmpdir/flag.log" 2>&1; then
  fail_case "removed-tool-flag" "removed --tool flag unexpectedly succeeded" "$tmpdir/flag.log" "$tmpdir"
fi
grep -q 'Unknown argument: --tool' "$tmpdir/flag.log" \
  || fail_case "removed-tool-flag" "missing unknown-argument diagnostic" "$tmpdir/flag.log" "$tmpdir"

if (cd "$tmpdir/repo" && RALPH_TIMEOUT_SECONDS=0 ./ralph.sh 0) >"$tmpdir/timeout.log" 2>&1; then
  fail_case "positive-timeout" "zero timeout unexpectedly succeeded" "$tmpdir/timeout.log" "$tmpdir"
fi
grep -q 'RALPH_TIMEOUT_SECONDS must be a positive integer' "$tmpdir/timeout.log" \
  || fail_case "positive-timeout" "missing positive-timeout diagnostic" "$tmpdir/timeout.log" "$tmpdir"

mkdir -p "$tmpdir/repo/bin"
cat >"$tmpdir/repo/bin/codex" <<'EOF'
#!/bin/sh
exit 0
EOF
chmod +x "$tmpdir/repo/bin/codex"
if (cd "$tmpdir/repo" && PATH="$tmpdir/repo/bin:$PATH" MODE=audit ./ralph.sh --dry-run 1) \
  >"$tmpdir/local-codex.log" 2>&1; then
  fail_case "codex-outside-repo" "repository-local Codex unexpectedly succeeded" "$tmpdir/local-codex.log" "$tmpdir"
fi
grep -q 'Refusing to execute Codex from inside the repository' "$tmpdir/local-codex.log" \
  || fail_case "codex-outside-repo" "missing executable confinement diagnostic" "$tmpdir/local-codex.log" "$tmpdir"

cleanup_dir "$tmpdir"
printf 'PASS [codex-only-tool-contract]\n'
