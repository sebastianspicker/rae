#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
EVALS_DIR="$ROOT_DIR/evals"
VALIDATOR="$ROOT_DIR/evals/scripts/validate_eval_metadata.py"

usage() {
  cat <<'EOF'
Usage: ./evals/harness/run-local.sh <command>

Commands:
  validate      Validate benchmark and run-card metadata
  route         Route one task spec and emit a planned run card
  run           Execute one benchmark split and emit run/result/regression artifacts
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

check_command() {
  local label="$1"
  local cmd="$2"
  if command -v "$cmd" >/dev/null 2>&1; then
    doctor_line "OK" "$label" "$(command -v "$cmd")"
    return 0
  fi
  doctor_line "FAIL" "$label" "missing command: $cmd"
  return 1
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
  check_command "python3" "python3" || failed=1
  check_file "validator" "$VALIDATOR" || failed=1
  check_file "router" "$ROOT_DIR/evals/scripts/router.py" || failed=1
  check_file "benchmark-runner" "$ROOT_DIR/evals/scripts/run_benchmark.py" || failed=1
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
    python3 "$VALIDATOR" "$@"
    ;;
  route)
    python3 "$ROOT_DIR/evals/scripts/router.py" "$@"
    ;;
  run)
    python3 "$ROOT_DIR/evals/scripts/run_benchmark.py" "$@"
    ;;
  suite)
    bash "$ROOT_DIR/evals/harness/run-frozen-suite.sh" "$@"
    ;;
  calibrate)
    python3 "$ROOT_DIR/evals/scripts/judge_calibration.py" "$@"
    ;;
  release-gate)
    python3 "$ROOT_DIR/evals/scripts/release_gate.py" "$@"
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
