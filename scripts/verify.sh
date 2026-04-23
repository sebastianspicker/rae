#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_DIR=""
VERDICT="PASS"

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
  if [[ -n "$TMP_DIR" && -d "$TMP_DIR" ]]; then
    rm -rf "$TMP_DIR"
  fi
}
trap cleanup EXIT

require_command bash python3 git rg node npm jq mkdocs shellcheck

python3 "$ROOT_DIR/scripts/verify_repo.py"
python3 -m pytest evals/tests tests
bash "$ROOT_DIR/evals/harness/run-local.sh" validate
bash "$ROOT_DIR/profiles/agent-environments/tests/profile-installation.sh"
bash "$ROOT_DIR/scripts/rae.sh" --help >/dev/null
bash "$ROOT_DIR/scripts/rae.sh" doctor >/dev/null
bash "$ROOT_DIR/scripts/rae.sh" eval validate >/dev/null

TMP_DIR="$(mktemp -d "$ROOT_DIR/evals/results/verify.XXXXXX")"
bash "$ROOT_DIR/scripts/rae.sh" workflow long-horizon init "$TMP_DIR/long-horizon-smoke" >/dev/null
test -f "$TMP_DIR/long-horizon-smoke/.pipeline/pipeline-state.json"

mkdir -p "$TMP_DIR/ralph-target"
bash "$ROOT_DIR/scripts/rae.sh" workflow repo-audit bootstrap "$TMP_DIR/ralph-target" >/dev/null
test -f "$TMP_DIR/ralph-target/.claude/ralph-audit/ralph.sh"
bash "$ROOT_DIR/scripts/rae.sh" hygiene coauthor-cleaner --help >/dev/null

bash "$ROOT_DIR/scripts/rae.sh" task route \
  --task-spec evals/datasets/tool-selection/tool-selection-core.task-specs.json \
  --task-id tool-selection-dev-orchestration \
  --output "$TMP_DIR/planned-route.json" >/dev/null
test -f "$TMP_DIR/planned-route.json"

bash "$ROOT_DIR/scripts/rae.sh" checkpoint create \
  --output "$TMP_DIR/checkpoint.json" \
  --run-id verify-run \
  --task-id verify-task \
  --gate-id review \
  --title "Verify checkpoint" >/dev/null
test -f "$TMP_DIR/checkpoint.json"

bash "$ROOT_DIR/scripts/rae.sh" eval calibrate \
  --judge-config evals/judges/programmatic-router-judge.json \
  --output "$TMP_DIR/judge-calibration.json" >/dev/null
test -f "$TMP_DIR/judge-calibration.json"

ORCH_DIR="$ROOT_DIR/packages/orchestration"
RALPH_DIR="$ROOT_DIR/packages/loops/ralph"
COAUTHOR_DIR="$ROOT_DIR/tools/repo-hygiene/coauthor-trailer-cleaner"

if [ "${SKIP_ORCHESTRATION_VERIFY:-0}" != "1" ] && [ -f "$ORCH_DIR/package.json" ]; then
  (
    cd "$ORCH_DIR"
    ./scripts/verify.sh
  )
else
  VERDICT="PARTIAL"
fi

bash "$ROOT_DIR/scripts/rae.sh" eval run \
  --benchmark-card evals/benchmarks/tool-selection-core.benchmark-card.json \
  --split dev \
  --output-dir "$TMP_DIR/dev" >/dev/null
bash "$ROOT_DIR/scripts/rae.sh" eval run \
  --benchmark-card evals/benchmarks/tool-selection-core.benchmark-card.json \
  --split held-out \
  --output-dir "$TMP_DIR/held-out" >/dev/null
find "$TMP_DIR/dev" -maxdepth 1 -type f -name 'run-card-*.json' | grep -q .
find "$TMP_DIR/held-out" -maxdepth 1 -type f -name 'release-gate-*.json' | grep -q .

bash "$ROOT_DIR/evals/harness/run-frozen-suite.sh" "$TMP_DIR/frozen-benchmarks" >/dev/null
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
    bash ./tests/run-tests.sh
  )
else
  VERDICT="PARTIAL"
fi

shellcheck "$ROOT_DIR/scripts/verify.sh"
shellcheck "$ROOT_DIR/scripts/rae.sh"
shellcheck "$ROOT_DIR/evals/harness/run-local.sh"
shellcheck "$ROOT_DIR/evals/harness/run-frozen-suite.sh"
shellcheck "$ROOT_DIR/profiles/agent-environments/installers/install-profile.sh"
shellcheck "$ROOT_DIR/profiles/agent-environments/installers/uninstall-profile.sh"
shellcheck "$ROOT_DIR/profiles/agent-environments/tests/profile-installation.sh"

echo "VERDICT: $VERDICT"
