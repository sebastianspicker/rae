#!/usr/bin/env bash
# Runs local evaluation checks with the repository harness to make benchmark evidence reproducible.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=scripts/lib/runtime.sh
source "$ROOT_DIR/scripts/lib/runtime.sh"
rae_require_runtime

BASH_BIN="$BASH"
EVALS_DIR="$ROOT_DIR/evals"
VALIDATOR="$ROOT_DIR/evals/scripts/validate_eval_metadata.py"

usage() {
  cat <<'EOF'
Usage: ./evals/harness/run-local.sh <command>

Commands:
  validate      Validate benchmark and run-card metadata
  route         Route one task spec and emit a planned run card
  run           Execute one benchmark split and emit run/result/regression artifacts
  outcome       Run experimental autonomous code-change outcomes (provider usage requires acknowledgement)
  compare-outcomes
                Compare paired outcome reports for optimizer evidence
  optimize      Evaluate a bounded experimental policy campaign from precomputed evidence
  improve       Evaluate a sealed evaluator-owned RAE v2 improvement campaign
  suite         Execute all frozen benchmark families for dev and held-out splits under evals/results
  calibrate     Run judge calibration
  release-gate  Evaluate release-blocking gates for a run card
  doctor        Print the local eval harness inventory
  help          Show this help
EOF
}

count_json_matches() {
  find "$EVALS_DIR" -type f \( "$@" \) | wc -l | tr -d ' '
}

doctor_line() {
  local status="$1"
  local label="$2"
  local detail="$3"
  printf '%-6s %-18s %s\n' "$status" "$label" "$detail"
}

check_file() {
  local label="$1"
  local path="$2"
  local relative_path="${path#"$ROOT_DIR"/}"
  if [[ -f "$path" ]]; then
    doctor_line "OK" "$label" "$relative_path"
    return 0
  fi
  doctor_line "FAIL" "$label" "$relative_path missing"
  return 1
}

run_doctor() {
  local failed=0
  local relative_validator="${VALIDATOR#"$ROOT_DIR"/}"
  printf 'evals root        %s\n' "$EVALS_DIR"
  printf 'scenario dirs     %s\n' "$(find "$EVALS_DIR/scenarios" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')"
  printf 'benchmark cards   %s\n' "$(count_json_matches -name '*.benchmark-card.json' -o -name 'benchmark-card.example.json')"
  printf 'run cards         %s\n' "$(count_json_matches -name '*.run-card.json' -o -name 'run-card-*.json' -o -name 'run-card.example.json')"
  printf 'schemas           %s\n' "$(find "$EVALS_DIR/schemas" -maxdepth 1 -type f -name '*.json' | wc -l | tr -d ' ')"
  printf 'validator         %s\n' "$relative_validator"

  printf '\n'
  doctor_line "OK" "bash" "$BASH_VERSION ($BASH_BIN)"
  doctor_line "OK" "python" "$(rae_python_version "$PYTHON_BIN") ($PYTHON_BIN)"
  check_file "validator" "$VALIDATOR" || failed=1
  check_file "router" "$ROOT_DIR/evals/scripts/router.py" || failed=1
  check_file "benchmark-runner" "$ROOT_DIR/evals/scripts/run_benchmark.py" || failed=1
  check_file "outcome-runner" "$ROOT_DIR/evals/scripts/run_outcome_benchmark.py" || failed=1
  check_file "outcome-compare" "$ROOT_DIR/evals/scripts/compare_outcome_reports.py" || failed=1
  check_file "policy-optimizer" "$ROOT_DIR/evals/scripts/optimize_harness.py" || failed=1
  check_file "policy-improvement" "$ROOT_DIR/evals/scripts/improve_harness.py" || failed=1
  check_file "release-gate" "$ROOT_DIR/evals/scripts/release_gate.py" || failed=1

  if [[ "$failed" -ne 0 ]]; then
    printf 'VERDICT: FAIL\n' >&2
    return 1
  fi

  printf 'VERDICT: PASS\n'
}

main() {
  local command="${1:-help}"
  shift || true

  case "$command" in
  help | -h | --help)
    usage
    ;;
  validate)
    "$PYTHON_BIN" "$VALIDATOR" "$@"
    ;;
  route)
    "$PYTHON_BIN" "$ROOT_DIR/evals/scripts/router.py" "$@"
    ;;
  run)
    "$PYTHON_BIN" "$ROOT_DIR/evals/scripts/run_benchmark.py" "$@"
    ;;
  outcome)
    "$PYTHON_BIN" "$ROOT_DIR/evals/scripts/run_outcome_benchmark.py" "$@"
    ;;
  compare-outcomes)
    "$PYTHON_BIN" "$ROOT_DIR/evals/scripts/compare_outcome_reports.py" "$@"
    ;;
  optimize)
    "$PYTHON_BIN" "$ROOT_DIR/evals/scripts/optimize_harness.py" "$@"
    ;;
  improve)
    "$PYTHON_BIN" "$ROOT_DIR/evals/scripts/improve_harness.py" "$@"
    ;;
  suite)
    "$BASH_BIN" "$ROOT_DIR/evals/harness/run-frozen-suite.sh" "$@"
    ;;
  calibrate)
    "$PYTHON_BIN" "$ROOT_DIR/evals/scripts/judge_calibration.py" "$@"
    ;;
  release-gate)
    "$PYTHON_BIN" "$ROOT_DIR/evals/scripts/release_gate.py" "$@"
    ;;
  doctor)
    run_doctor "$@"
    ;;
  *)
    printf 'ERROR: unknown eval harness command: %s\n' "$command" >&2
    exit 1
    ;;
  esac
}

main "$@"
