#!/usr/bin/env bash

set -euo pipefail

# shellcheck source=tests/lib/test_helpers.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/test_helpers.sh"

require_cmds mktemp

# Test that mktemp is available and creates a directory with -d
tmpdir="$(mktemp -d)"
[[ -d "$tmpdir" ]] || fail_case "compat-mktemp" "mktemp -d did not create directory" "" ""
rmdir "$tmpdir"

# Test that mktemp creates a file without template
tmpfile="$(mktemp)"
[[ -f "$tmpfile" ]] || fail_case "compat-mktemp" "mktemp did not create file" "" ""
rm -f "$tmpfile"

# Test that mktemp with template works
tmplfile="$(mktemp /tmp/ralph-test.XXXXXX)"
[[ -f "$tmplfile" ]] || fail_case "compat-mktemp" "mktemp with template did not create file" "" ""
rm -f "$tmplfile"

printf 'PASS [compat-mktemp]\n'
