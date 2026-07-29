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
    "$ROOT_DIR/evals/scripts" \
    "$ROOT_DIR/evals/tests" \
    "$ROOT_DIR/packages/loops/ralph/scripts" \
    "$ROOT_DIR/packages/orchestration/scripts" \
    "$ROOT_DIR/profiles/agent-environments/installers" \
    "$ROOT_DIR/scripts" \
    "$ROOT_DIR/tests"
  ruff check "$ROOT_DIR"
  ruff format --check "$ROOT_DIR"
  pyright --project "$ROOT_DIR/pyrightconfig.json"
  # Lizard warns at the argument limit, so use 9 to enforce the policy maximum of 8.
  lizard -l python -C 12 -L 80 -a 9 -w \
    -x '*/tests/*' \
    "$ROOT_DIR/evals/scripts" \
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
"$PYTHON_BIN" -m pytest evals/tests tests
"$BASH_BIN" "$ROOT_DIR/tests/runtime-contract.sh"
"$BASH_BIN" "$ROOT_DIR/evals/harness/run-local.sh" validate
"$BASH_BIN" "$ROOT_DIR/profiles/agent-environments/tests/profile-installation.sh"
"$BASH_BIN" "$ROOT_DIR/scripts/rae.sh" --help >/dev/null
"$BASH_BIN" "$ROOT_DIR/scripts/rae.sh" doctor >/dev/null
"$BASH_BIN" "$ROOT_DIR/scripts/rae.sh" eval validate >/dev/null

TMP_DIR="$(mktemp -d "$ROOT_DIR/evals/results/verify.XXXXXX")"
"$BASH_BIN" "$ROOT_DIR/scripts/rae.sh" workflow long-horizon init "$TMP_DIR/long-horizon-smoke" >/dev/null
test -f "$TMP_DIR/long-horizon-smoke/.pipeline/pipeline-state.json"

mkdir -p "$TMP_DIR/ralph-target"
"$BASH_BIN" "$ROOT_DIR/scripts/rae.sh" workflow repo-audit bootstrap "$TMP_DIR/ralph-target" >/dev/null
test -f "$TMP_DIR/ralph-target/.claude/ralph-audit/ralph.sh"
"$BASH_BIN" "$ROOT_DIR/scripts/rae.sh" hygiene coauthor-cleaner --help >/dev/null

"$BASH_BIN" "$ROOT_DIR/scripts/rae.sh" task route \
  --task-spec evals/datasets/tool-selection/tool-selection-core.task-specs.json \
  --task-id tool-selection-dev-orchestration \
  --output "$TMP_DIR/planned-route.json" >/dev/null
test -f "$TMP_DIR/planned-route.json"

"$BASH_BIN" "$ROOT_DIR/scripts/rae.sh" checkpoint create \
  --output "$TMP_DIR/checkpoint.json" \
  --run-id verify-run \
  --task-id verify-task \
  --gate-id review \
  --title "Verify checkpoint" >/dev/null
test -f "$TMP_DIR/checkpoint.json"

"$BASH_BIN" "$ROOT_DIR/scripts/rae.sh" eval calibrate \
  --judge-config evals/judges/programmatic-router-judge.json \
  --output "$TMP_DIR/judge-calibration.json" >/dev/null
test -f "$TMP_DIR/judge-calibration.json"

ORCH_DIR="$ROOT_DIR/packages/orchestration"
RALPH_DIR="$ROOT_DIR/packages/loops/ralph"
COAUTHOR_DIR="$ROOT_DIR/tools/repo-hygiene/coauthor-trailer-cleaner"

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

"$BASH_BIN" "$ROOT_DIR/scripts/rae.sh" eval run \
  --benchmark-card evals/benchmarks/tool-selection-core.benchmark-card.json \
  --split dev \
  --output-dir "$TMP_DIR/dev" >/dev/null
"$BASH_BIN" "$ROOT_DIR/scripts/rae.sh" eval run \
  --benchmark-card evals/benchmarks/tool-selection-core.benchmark-card.json \
  --split held-out \
  --output-dir "$TMP_DIR/held-out" >/dev/null
find "$TMP_DIR/dev" -maxdepth 1 -type f -name 'run-card-*.json' | grep -q .
find "$TMP_DIR/held-out" -maxdepth 1 -type f -name 'release-gate-*.json' | grep -q .

"$BASH_BIN" "$ROOT_DIR/evals/harness/run-frozen-suite.sh" "$TMP_DIR/frozen-benchmarks" >/dev/null
find "$TMP_DIR/frozen-benchmarks" -type f -name 'release-gate-*.json' | grep -q .

if [ "${SKIP_RALPH_VERIFY:-0}" != "1" ] && [ -f "$RALPH_DIR/ralph.sh" ]; then
  (
    cd "$RALPH_DIR"
    ./scripts/run_tests.sh
  )
else
  VERDICT="PARTIAL"
fi

if [ "${SKIP_COAUTHOR_VERIFY:-0}" != "1" ] && [ -f "$COAUTHOR_DIR/coauthor-trailer-cleaner.sh" ]; then
  (
    cd "$COAUTHOR_DIR"
    "$BASH_BIN" ./tests/run-tests.sh
  )
else
  VERDICT="PARTIAL"
fi

run_shell_quality_gate

echo "VERDICT: $VERDICT"
