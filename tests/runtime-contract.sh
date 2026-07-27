#!/usr/bin/env bash
# Checks shell entrypoints reject unsupported runtime versions before running repository workflows.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/lib/runtime.sh
source "$ROOT_DIR/scripts/lib/runtime.sh"

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

rae_bash_tuple_ok 5 3 || fail "Bash 5.3 must satisfy the runtime floor"
rae_bash_tuple_ok 6 0 || fail "newer Bash majors must satisfy the runtime floor"
if rae_bash_tuple_ok 5 2; then
  fail "Bash 5.2 must not satisfy the runtime floor"
fi

rae_require_runtime || fail "the active runtime must satisfy the repository contract"
rae_python_version_ok "$PYTHON_BIN" ||
  fail "the active Python must satisfy the 3.14.6 runtime floor"
active_python="$PYTHON_BIN"

tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/rae-runtime-test.XXXXXX")"
trap 'rm -rf "$tmp_dir"' EXIT
cat >"$tmp_dir/python3" <<'SH'
#!/usr/bin/env bash
if [[ "${2:-}" == *"raise SystemExit"* ]]; then
  exit 1
fi
printf '3.14.5\n'
SH
chmod +x "$tmp_dir/python3"

if (unset PYTHON_BIN; PATH="$tmp_dir" rae_resolve_python >/dev/null 2>&1); then
  fail "Python 3.14.5 must not satisfy the runtime floor"
fi

# shellcheck disable=SC2030
(
  PYTHON_BIN="$active_python"
  PATH="$tmp_dir"
  rae_resolve_python
) || fail "an explicit supported PYTHON_BIN must take precedence"

real_node="$(command -v node)"
mkdir "$tmp_dir/bin"
cat >"$tmp_dir/bin/node" <<'SH'
#!/usr/bin/env bash
if [[ "${1:-}" == "--version" ]]; then
  printf '%s\n' "${FAKE_NODE_VERSION:?FAKE_NODE_VERSION is required}"
  exit 0
fi
exec "${RAE_RUNTIME_TEST_REAL_NODE:?RAE_RUNTIME_TEST_REAL_NODE is required}" "$@"
SH
chmod +x "$tmp_dir/bin/node"

assert_doctor_node_version() {
  local version="$1"
  local expected_status="$2"
  local output status

  set +e
  # shellcheck disable=SC2031
  output="$(PATH="$tmp_dir/bin:$PATH" FAKE_NODE_VERSION="$version" RAE_RUNTIME_TEST_REAL_NODE="$real_node" "$ROOT_DIR/scripts/rae.sh" doctor 2>&1)"
  status=$?
  set -e

  if [[ "$expected_status" == "pass" && "$status" -ne 0 ]]; then
    printf '%s\n' "$output" >&2
    fail "doctor must accept Node $version"
  fi
  if [[ "$expected_status" == "fail" && "$status" -eq 0 ]]; then
    printf '%s\n' "$output" >&2
    fail "doctor must reject Node $version"
  fi
  if [[ "$expected_status" == "pass" ]] && ! grep -Fq "OK     node" <<<"$output"; then
    printf '%s\n' "$output" >&2
    fail "doctor must report Node $version as supported"
  fi
  if [[ "$expected_status" == "fail" ]] && ! grep -Fq "FAIL   node" <<<"$output"; then
    printf '%s\n' "$output" >&2
    fail "doctor must report Node $version as unsupported"
  fi
}

assert_doctor_node_version v18.20.8 fail
assert_doctor_node_version v20.18.3 fail
assert_doctor_node_version v20.19.0 pass
assert_doctor_node_version v21.7.3 fail
assert_doctor_node_version v22.11.0 fail
assert_doctor_node_version v22.12.0 pass
assert_doctor_node_version v23.11.1 fail
assert_doctor_node_version v24.0.0 pass
assert_doctor_node_version v26.5.0 pass

assert_direct_node_workflow() {
  local version="$1"
  local command="$2"
  local expected_status="$3"
  local output status

  set +e
  # shellcheck disable=SC2031
  output="$(
    PATH="$tmp_dir/bin:$PATH" \
      FAKE_NODE_VERSION="$version" \
      RAE_RUNTIME_TEST_REAL_NODE="$real_node" \
      "$ROOT_DIR/scripts/rae.sh" "$command" help 2>&1
  )"
  status=$?
  set -e

  if [[ "$expected_status" == "pass" && "$status" -ne 0 ]]; then
    printf '%s\n' "$output" >&2
    fail "$command must accept Node $version"
  fi
  if [[ "$expected_status" == "fail" && "$status" -eq 0 ]]; then
    printf '%s\n' "$output" >&2
    fail "$command must reject Node $version"
  fi
  if [[ "$expected_status" == "fail" ]] && ! grep -Fq "FAIL   node" <<<"$output"; then
    printf '%s\n' "$output" >&2
    fail "$command must report unsupported Node $version before execution"
  fi
}

assert_direct_node_workflow v18.20.8 agent fail
assert_direct_node_workflow v22.12.0 agent pass
assert_direct_node_workflow v18.20.8 operator fail
assert_direct_node_workflow v22.12.0 operator pass

printf 'PASS: runtime contract\n'
