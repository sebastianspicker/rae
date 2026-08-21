#!/usr/bin/env bash
# Runs repository quality gates so local verification mirrors the supported CI contract.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/lib/runtime.sh
source "$ROOT_DIR/scripts/lib/runtime.sh"
rae_require_runtime
export PYTHONDONTWRITEBYTECODE=1

BASH_BIN="$BASH"
CACHE_DIR=""
TMP_DIR=""
VERDICT="PASS"
SKIP_INSTALL=0
SKIP_MKDOCS=0
RELEASE_CANDIDATE=0

for arg in "$@"; do
  case "$arg" in
  --skip-install)
    SKIP_INSTALL=1
    ;;
  --skip-mkdocs)
    SKIP_MKDOCS=1
    VERDICT="PARTIAL"
    ;;
  --release-candidate)
    RELEASE_CANDIDATE=1
    ;;
  *)
    printf 'ERROR: unknown verification option: %s\n' "$arg" >&2
    exit 2
    ;;
  esac
done

if [[ "$RELEASE_CANDIDATE" -eq 1 && ( "$SKIP_INSTALL" -eq 1 || "$SKIP_MKDOCS" -eq 1 ) ]]; then
  printf 'ERROR: --release-candidate cannot be combined with partial verification modes\n' >&2
  exit 2
fi

require_command() {
  local cmd
  for cmd in "$@"; do
    command -v "$cmd" >/dev/null 2>&1 || {
      printf 'ERROR: required command not found: %s\n' "$cmd" >&2
      exit 1
    }
  done
}

cleanup() {
  if [[ -n "$CACHE_DIR" && -d "$CACHE_DIR" ]]; then
    rm -rf "$CACHE_DIR"
  fi
  if [[ -n "$TMP_DIR" && -d "$TMP_DIR" ]]; then
    rm -rf "$TMP_DIR"
  fi
}
trap cleanup EXIT

collect_tracked_shell_files() {
  local relative_path first_line
  while IFS= read -r -d '' relative_path; do
    [[ -f "$ROOT_DIR/$relative_path" ]] || continue
    if [[ "$relative_path" == *.sh ]]; then
      printf '%s\0' "$ROOT_DIR/$relative_path"
      continue
    fi
    IFS= read -r first_line <"$ROOT_DIR/$relative_path" || true
    if [[ "$first_line" == '#!'*bash* ]]; then
      printf '%s\0' "$ROOT_DIR/$relative_path"
    fi
  done < <(git -C "$ROOT_DIR" ls-files -co --exclude-standard -z)
}

run_python_quality_gates() {
  PYTHONPYCACHEPREFIX="$CACHE_DIR" "$PYTHON_BIN" -m compileall -q \
    "$ROOT_DIR/packages/loops/ralph/scripts" \
    "$ROOT_DIR/packages/orchestration/scripts" \
    "$ROOT_DIR/profiles/agent-environments/installers" \
    "$ROOT_DIR/scripts"
  ruff check "$ROOT_DIR"
  ruff format --check "$ROOT_DIR"
  pyright --project "$ROOT_DIR/pyrightconfig.json"
  # Lizard warns at the argument limit, so use 9 to enforce the policy maximum of 8.
  lizard -l python -C 12 -L 80 -a 9 -w \
    -x '*/tests/*' \
    "$ROOT_DIR/packages/loops/ralph/scripts" \
    "$ROOT_DIR/packages/orchestration/scripts" \
    "$ROOT_DIR/profiles/agent-environments/installers" \
    "$ROOT_DIR/scripts"
}

run_shell_quality_gate() {
  local -a shell_files=()
  mapfile -d '' -t shell_files < <(collect_tracked_shell_files)
  if [[ "${#shell_files[@]}" -eq 0 ]]; then
    printf 'ERROR: no tracked Bash files found for ShellCheck\n' >&2
    return 1
  fi
  shellcheck -x \
    -P "$ROOT_DIR" \
    -P "$ROOT_DIR/packages/loops/ralph" \
    -P "$ROOT_DIR/packages/orchestration" \
    -P "$ROOT_DIR/profiles/agent-environments" \
    -P "$ROOT_DIR/tools/repo-hygiene/coauthor-trailer-cleaner" \
    "${shell_files[@]}"
}

require_command bash git rg node npm jq shellcheck ruff pyright lizard
if [[ "$SKIP_MKDOCS" -eq 0 ]]; then
  require_command mkdocs
fi
CACHE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/rae-verify-pycache.XXXXXX")"

verify_repo_args=()
if [[ "$SKIP_MKDOCS" -eq 1 ]]; then
  verify_repo_args+=("--skip-mkdocs")
fi
if [[ "$RELEASE_CANDIDATE" -eq 1 ]]; then
  verify_repo_args+=("--release-candidate")
fi
"$PYTHON_BIN" "$ROOT_DIR/scripts/verify_repo.py" "${verify_repo_args[@]}"
run_python_quality_gates
"$BASH_BIN" "$ROOT_DIR/tests/runtime-contract.sh"
"$BASH_BIN" "$ROOT_DIR/scripts/rae.sh" --help >/dev/null
"$BASH_BIN" "$ROOT_DIR/scripts/rae.sh" doctor >/dev/null

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/rae-verify.XXXXXX")"
"$BASH_BIN" "$ROOT_DIR/scripts/rae.sh" workflow long-horizon init "$TMP_DIR/long-horizon-smoke" >/dev/null
test -f "$TMP_DIR/long-horizon-smoke/.pipeline/pipeline-state.json"

mkdir -p "$TMP_DIR/ralph-target"
"$BASH_BIN" "$ROOT_DIR/scripts/rae.sh" workflow repo-audit bootstrap "$TMP_DIR/ralph-target" >/dev/null
test -f "$TMP_DIR/ralph-target/.claude/ralph-audit/ralph.sh"
"$BASH_BIN" "$ROOT_DIR/scripts/rae.sh" hygiene coauthor-cleaner --help >/dev/null

ORCH_DIR="$ROOT_DIR/packages/orchestration"
RALPH_DIR="$ROOT_DIR/packages/loops/ralph"

if [ "${SKIP_ORCHESTRATION_VERIFY:-0}" != "1" ] && [ -f "$ORCH_DIR/package.json" ]; then
  (
    cd "$ORCH_DIR"
    if [[ "$SKIP_INSTALL" -eq 1 ]]; then
      ./scripts/verify.sh --skip-install
    else
      ./scripts/verify.sh
    fi
  )
else
  VERDICT="PARTIAL"
fi

if [ "${SKIP_RALPH_VERIFY:-0}" != "1" ] && [ -f "$RALPH_DIR/ralph.sh" ]; then
  (
    cd "$RALPH_DIR"
    ./scripts/run_tests.sh
  )
else
  VERDICT="PARTIAL"
fi

run_shell_quality_gate

echo "VERDICT: $VERDICT"
