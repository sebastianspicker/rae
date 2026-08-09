#!/usr/bin/env bash
# Dispatches the RAE umbrella CLI so users reach supported workflows through one validated entrypoint.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/lib/runtime.sh
source "$ROOT_DIR/scripts/lib/runtime.sh"
rae_require_bash || exit 1

CALLER_PWD="$(pwd)"
ORCH_DIR="$ROOT_DIR/packages/orchestration"
RALPH_DIR="$ROOT_DIR/packages/loops/ralph"
COAUTHOR_SCRIPT="$ROOT_DIR/tools/repo-hygiene/coauthor-trailer-cleaner/coauthor-trailer-cleaner.sh"
EVAL_HARNESS="$ROOT_DIR/evals/harness/run-local.sh"
AGENT_RUNNER="$ORCH_DIR/scripts/pipeline/autonomous.mjs"
GRAPH_RUNNER="$ORCH_DIR/scripts/pipeline/graph-cli.mjs"
OPERATOR_SERVER="$ORCH_DIR/operator/server.mjs"

usage() {
  cat <<'EOF'
Usage: ./scripts/rae.sh <command> [args]

RAE umbrella CLI.

Commands:
  verify [--skip-install] [--skip-mkdocs] [--release-candidate]
                                       Run umbrella verification
  doctor                               Check runtime prerequisites and entrypoints
  agent <subcommand> [args]            Run the autonomous coding-agent orchestrator
  graph <subcommand> [args]            Build and query local graph projections and memory
  operator serve [args]                Serve the authenticated loopback operator console
  task route [args]                    Route a task spec and emit a planned run card
  checkpoint <subcommand> [args]       Create or resolve human checkpoint cards
  orchestrate <subcommand> [args]      Run the phased orchestration package
  worktree <subcommand> [args]         Run worktree-native orchestration aliases
  ralph <subcommand> [args]            Run Ralph or bootstrap its embedded template
  hygiene <tool> [args]                Run narrow maintenance tooling
  eval <subcommand> [args]             Run eval metadata harness commands
  release-gate [args]                  Evaluate release-blocking benchmark gates
  workflow <family> [args]             Run umbrella workflow aliases
  help                                 Show this help

Examples:
  ./scripts/rae.sh doctor
  ./scripts/rae.sh agent doctor
  ./scripts/rae.sh agent run --task "Add a tested health endpoint and document it"
  ./scripts/rae.sh graph build --project-root /absolute/path/to/repository
  ./scripts/rae.sh operator serve --project /absolute/path/to/repository
  ./scripts/rae.sh task route --task-spec evals/datasets/tool-selection/tool-selection-core.task-specs.json --task-id tool-selection-dev-orchestration --output evals/results/planned.json
  ./scripts/rae.sh orchestrate init
  ./scripts/rae.sh orchestrate run-stage --run-id <id> --phase arm
  ./scripts/rae.sh orchestrate record-review-state --run-id <id> --state explain --status completed
  ./scripts/rae.sh orchestrate summarize-progress --run-id <id>
  ./scripts/rae.sh ralph --status
  ./scripts/rae.sh ralph bootstrap-template /tmp/demo-repo
  ./scripts/rae.sh hygiene coauthor-cleaner --help
  ./scripts/rae.sh checkpoint create --output evals/results/checkpoint.json --run-id demo --task-id task --gate-id review --title "Review"
  ./scripts/rae.sh eval validate
  ./scripts/rae.sh eval run --benchmark-card evals/benchmarks/tool-selection-core.benchmark-card.json --split dev --output-dir evals/results/tmp
  ./scripts/rae.sh eval outcome --task-bundle evals/datasets/autonomous-outcomes/core.task-bundle.json --fixture-root evals/fixtures/autonomous-outcomes --policy packages/orchestration/policies/default.autonomous-policy.json --split dev --repeats 2 --output-dir evals/results/outcomes/dev --acknowledge-provider-usage
  ./scripts/rae.sh release-gate --benchmark-card evals/benchmarks/tool-selection-core.benchmark-card.json --run-card evals/results/tmp/run-card.json --regression-report evals/results/tmp/regression.json --ledger evals/results/tmp/result-ledger.jsonl --output evals/results/tmp/release-gate.json
  ./scripts/rae.sh worktree init .
  ./scripts/rae.sh worktree summary --run-id <id>
  ./scripts/rae.sh workflow repo-audit bootstrap /tmp/demo-repo
  ./scripts/rae.sh workflow long-horizon init
EOF
}

die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

require_command() {
  local cmd
  for cmd in "$@"; do
    command -v "$cmd" >/dev/null 2>&1 || die "required command not found: $cmd"
  done
}

resolve_input_path() {
  local input="$1"
  # Commands are often launched from subdirectories; resolve user-provided
  # relative paths against the caller's directory, not the script directory.
  if [[ "$input" = /* ]]; then
    printf '%s\n' "$input"
  else
    printf '%s/%s\n' "$CALLER_PWD" "$input"
  fi
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

check_bash_runtime() {
  if rae_bash_version_ok; then
    doctor_line "OK" "bash" "$BASH_VERSION ($BASH)"
    return 0
  fi
  doctor_line "FAIL" "bash" "requires >=5.3; running $BASH_VERSION"
  return 1
}

check_python_runtime() {
  if ! rae_resolve_python 2>/dev/null; then
    doctor_line "FAIL" "python" "requires >=3.14.6; no supported interpreter found"
    return 1
  fi
  doctor_line "OK" "python" "$(rae_python_version "$PYTHON_BIN") ($PYTHON_BIN)"
}

check_node_runtime() {
  local node_bin="${RAE_NODE_BIN:-node}"
  local version major minor patch

  if ! node_bin="$(command -v "$node_bin" 2>/dev/null)"; then
    doctor_line "FAIL" "node" "missing command: ${RAE_NODE_BIN:-node}"
    return 1
  fi

  version="$("$node_bin" --version 2>/dev/null || true)"
  if [[ ! "$version" =~ ^v?([0-9]+)\.([0-9]+)\.([0-9]+)$ ]]; then
    doctor_line "FAIL" "node" "unable to parse version: ${version:-no version output}"
    return 1
  fi

  major="${BASH_REMATCH[1]}"
  minor="${BASH_REMATCH[2]}"
  patch="${BASH_REMATCH[3]}"
  case "$major" in
  20)
    if ((minor >= 19)); then
      doctor_line "OK" "node" "v$major.$minor.$patch ($node_bin)"
      return 0
    fi
    ;;
  22)
    if ((minor >= 12)); then
      doctor_line "OK" "node" "v$major.$minor.$patch ($node_bin)"
      return 0
    fi
    ;;
  *)
    if ((major >= 24)); then
      doctor_line "OK" "node" "v$major.$minor.$patch ($node_bin)"
      return 0
    fi
    ;;
  esac

  doctor_line "FAIL" "node" "requires >=20.19.0 <21 || >=22.12.0 <23 || >=24.0.0; running v$major.$minor.$patch"
  return 1
}

require_node_runtime() {
  local output
  if ! output="$(check_node_runtime)"; then
    printf '%s\n' "$output" >&2
    return 1
  fi
  NODE_BIN="$(command -v "${RAE_NODE_BIN:-node}")"
}

check_optional_command() {
  local label="$1"
  local cmd="$2"
  if command -v "$cmd" >/dev/null 2>&1; then
    doctor_line "OK" "$label" "$(command -v "$cmd")"
  else
    doctor_line "WARN" "$label" "optional command missing: $cmd"
  fi
}

check_file() {
  local label="$1"
  local path="$2"
  local relative_path="${path#"$ROOT_DIR"/}"
  if [[ -e "$path" ]]; then
    doctor_line "OK" "$label" "$relative_path"
    return 0
  fi
  doctor_line "FAIL" "$label" "$relative_path missing"
  return 1
}

check_entrypoint() {
  local label="$1"
  shift
  if "$@" >/dev/null 2>&1; then
    doctor_line "OK" "$label" "entrypoint runnable"
    return 0
  fi
  doctor_line "FAIL" "$label" "entrypoint failed"
  return 1
}

run_verify() {
  exec "$ROOT_DIR/scripts/verify.sh" "$@"
}

run_doctor() {
  local failed=0

  printf 'RAE doctor\n'
  printf 'root   %s\n' "$ROOT_DIR"
  printf 'pwd    %s\n' "$CALLER_PWD"
  printf '\n'

  check_bash_runtime || failed=1
  check_python_runtime || failed=1
  check_command "git" "git" || failed=1
  check_command "rg" "rg" || failed=1
  check_node_runtime || failed=1
  check_command "npm" "npm" || failed=1
  check_command "jq" "jq" || failed=1
  check_optional_command "mkdocs" "mkdocs"
  check_command "shellcheck" "shellcheck" || failed=1
  check_optional_command "git-filter-repo" "git-filter-repo"

  printf '\n'

  check_file "umbrella-cli" "$ROOT_DIR/scripts/rae.sh" || failed=1
  check_file "verify" "$ROOT_DIR/scripts/verify.sh" || failed=1
  check_file "eval-harness" "$EVAL_HARNESS" || failed=1
  check_file "orchestrate" "$ORCH_DIR/scripts/pipeline-init.sh" || failed=1
  check_file "agent-runner" "$AGENT_RUNNER" || failed=1
  check_file "graph-runner" "$GRAPH_RUNNER" || failed=1
  check_file "operator-console" "$OPERATOR_SERVER" || failed=1
  check_file "ralph" "$RALPH_DIR/ralph.sh" || failed=1
  check_file "hygiene" "$COAUTHOR_SCRIPT" || failed=1

  printf '\n'

  check_entrypoint "umbrella-help" bash "$ROOT_DIR/scripts/rae.sh" --help || failed=1
  check_entrypoint "eval-help" bash "$EVAL_HARNESS" --help || failed=1
  check_entrypoint "eval-doctor" bash "$EVAL_HARNESS" doctor || failed=1
  check_entrypoint "orchestrate-help" bash "$ROOT_DIR/scripts/rae.sh" orchestrate help || failed=1
  check_entrypoint "agent-help" bash "$ROOT_DIR/scripts/rae.sh" agent help || failed=1
  check_entrypoint "ralph-help" bash "$RALPH_DIR/ralph.sh" --help || failed=1
  check_entrypoint "hygiene-help" bash "$COAUTHOR_SCRIPT" --help || failed=1

  if [[ "$failed" -ne 0 ]]; then
    printf '\nVERDICT: FAIL\n' >&2
    return 1
  fi

  printf '\nVERDICT: PASS\n'
}

run_orchestration() {
  local subcommand="${1:-help}"
  shift || true

  case "$subcommand" in
  help | -h | --help)
    require_node_runtime
    (cd "$ORCH_DIR" && "$NODE_BIN" scripts/pipeline/runner.mjs --help)
    ;;
  init)
    local project_root=""
    if [[ $# -gt 0 && "$1" != --* ]]; then
      project_root="$(resolve_input_path "$1")"
      shift
    fi
    if [[ -n "$project_root" ]]; then
      (cd "$ORCH_DIR" && ./scripts/pipeline-init.sh "$project_root" "$@")
    else
      (cd "$ORCH_DIR" && ./scripts/pipeline-init.sh "$@")
    fi
    ;;
  run-stage | start-phase | end-phase | record-artifact | record-gate | record-review-state | summarize-run | summarize-progress | doctor)
    require_node_runtime
    (cd "$ORCH_DIR" && "$NODE_BIN" scripts/pipeline/runner.mjs "$subcommand" "$@")
    ;;
  *)
    die "unknown orchestrate subcommand: $subcommand"
    ;;
  esac
}

run_agent() {
  require_command git
  require_node_runtime
  "$NODE_BIN" "$AGENT_RUNNER" "$@"
}

run_graph() {
  require_command git
  require_node_runtime
  "$NODE_BIN" "$GRAPH_RUNNER" "$@"
}

run_operator() {
  local subcommand="${1:-help}"
  shift || true

  case "$subcommand" in
  help | -h | --help)
    require_node_runtime
    "$NODE_BIN" "$OPERATOR_SERVER" --help
    ;;
  serve)
    require_command git
    require_node_runtime
    "$NODE_BIN" "$OPERATOR_SERVER" "$@"
    ;;
  *)
    die "unknown operator subcommand: $subcommand"
    ;;
  esac
}

run_worktree() {
  local subcommand="${1:-help}"
  shift || true

  case "$subcommand" in
  help | -h | --help)
    cat <<'EOF'
Usage: ./scripts/rae.sh worktree <subcommand> [args]

Subcommands:
  init [project-root] [--worktree-root <path>] [--branch-prefix <prefix>]
                               Create a dedicated orchestration worktree run
  summary --run-id <id>        Summarize one worktree-backed run
  review-state [args]          Record explain/fix/ship state for one run
  cleanup <path>               Remove a previously created worktree
EOF
    ;;
  init)
    local project_root="$ROOT_DIR"
    if [[ $# -gt 0 && "$1" != --* ]]; then
      project_root="$(resolve_input_path "$1")"
      shift
    fi
    (cd "$ORCH_DIR" && ./scripts/pipeline-init.sh "$project_root" --use-worktree "$@")
    ;;
  summary | summarize)
    run_orchestration summarize-progress "$@"
    ;;
  review-state)
    run_orchestration record-review-state "$@"
    ;;
  cleanup)
    [[ $# -ge 1 ]] || die "worktree cleanup requires a worktree path"
    local target
    target="$(resolve_input_path "$1")"
    shift
    [[ $# -eq 0 ]] || die "worktree cleanup accepts exactly one path"
    (cd "$ORCH_DIR" && ./scripts/pipeline-init.sh --cleanup-worktree "$target")
    ;;
  *)
    die "unknown worktree subcommand: $subcommand"
    ;;
  esac
}

run_ralph() {
  local subcommand="${1:-help}"
  shift || true

  case "$subcommand" in
  help | -h | --help)
    (cd "$RALPH_DIR" && ./ralph.sh --help)
    ;;
  bootstrap-template | bootstrap)
    (cd "$RALPH_DIR" && ./scripts/bootstrap_embedded.sh "$@")
    ;;
  tests)
    (cd "$RALPH_DIR" && ./scripts/run_tests.sh "$@")
    ;;
  *)
    (cd "$RALPH_DIR" && ./ralph.sh "$subcommand" "$@")
    ;;
  esac
}

run_hygiene() {
  local tool="${1:-help}"
  shift || true

  case "$tool" in
  help | -h | --help)
    cat <<'EOF'
Usage: ./scripts/rae.sh hygiene <tool> [args]

Tools:
  coauthor-cleaner        Run the coauthor trailer cleaner
EOF
    ;;
  coauthor-cleaner | coauthor-trailer-cleaner)
    "$COAUTHOR_SCRIPT" "$@"
    ;;
  *)
    die "unknown hygiene tool: $tool"
    ;;
  esac
}

run_eval() {
  local subcommand="${1:-help}"
  shift || true

  case "$subcommand" in
  help | -h | --help)
    "$EVAL_HARNESS" --help
    ;;
  validate | doctor | route | run | outcome | compare-outcomes | optimize | improve | calibrate | release-gate)
    "$EVAL_HARNESS" "$subcommand" "$@"
    ;;
  *)
    die "unknown eval subcommand: $subcommand"
    ;;
  esac
}

run_task() {
  local subcommand="${1:-help}"
  shift || true

  case "$subcommand" in
  route)
    run_eval route "$@"
    ;;
  help | -h | --help)
    cat <<'EOF'
Usage: ./scripts/rae.sh task route --task-spec <path> --output <run-card>
EOF
    ;;
  *)
    die "unknown task subcommand: $subcommand"
    ;;
  esac
}

run_checkpoint() {
  local subcommand="${1:-help}"
  shift || true

  case "$subcommand" in
  create | approve | reject | escalate)
    "$PYTHON_BIN" "$ROOT_DIR/evals/scripts/checkpoint.py" "$subcommand" "$@"
    ;;
  help | -h | --help)
    cat <<'EOF'
Usage: ./scripts/rae.sh checkpoint <create|approve|reject|escalate> [args]
EOF
    ;;
  *)
    die "unknown checkpoint subcommand: $subcommand"
    ;;
  esac
}

run_repo_audit_workflow() {
  local action="${1:-check}"
  shift || true
  case "$action" in
  help | -h | --help)
    cat <<'EOF'
Usage: ./scripts/rae.sh workflow repo-audit <action> [args]

Actions:
  bootstrap      Bootstrap Ralph's embedded template into a target repo
  check          Run Ralph in read-only validation mode
  doctor         Inspect Ralph prerequisites
  status         Show Ralph runtime status
  list-stories   List Ralph stories from the active PRD
  validate-prd   Validate the active Ralph PRD
  run            Pass explicit Ralph arguments through unchanged
EOF
    ;;
  bootstrap)
    run_ralph bootstrap "$@"
    ;;
  check)
    run_ralph --check "$@"
    ;;
  doctor)
    run_ralph --doctor "$@"
    ;;
  status)
    run_ralph --status "$@"
    ;;
  list-stories)
    run_ralph --list-stories "$@"
    ;;
  validate-prd)
    run_ralph --validate-prd "$@"
    ;;
  run)
    [[ $# -gt 0 ]] ||
      die "workflow repo-audit run expects Ralph arguments, for example: --mode audit 1"
    run_ralph "$@"
    ;;
  *)
    die "unknown repo-audit action: $action"
    ;;
  esac
}

run_long_horizon_workflow() {
  local action="${1:-help}"
  shift || true
  case "$action" in
  init | run-stage | start-phase | end-phase | record-artifact | record-gate | record-review-state | summarize-run | summarize-progress)
    run_orchestration "$action" "$@"
    ;;
  help | -h | --help)
    run_orchestration help
    ;;
  *)
    die "unknown long-horizon action: $action"
    ;;
  esac
}

run_workflow() {
  local family="${1:-help}"
  shift || true
  case "$family" in
  help | -h | --help)
    cat <<'EOF'
Usage: ./scripts/rae.sh workflow <family> [args]

Families:
  autonomous      Full coding-agent execution with code, tests, docs, and gates
  repo-audit      Ralph-based deterministic audit/fix workflow
  long-horizon    Phased orchestration workflow
  hygiene         Narrow maintenance tooling
EOF
    ;;
  autonomous | agent)
    run_agent "$@"
    ;;
  repo-audit)
    run_repo_audit_workflow "$@"
    ;;
  long-horizon)
    run_long_horizon_workflow "$@"
    ;;
  hygiene)
    run_hygiene "$@"
    ;;
  *)
    die "unknown workflow family: $family"
    ;;
  esac
}

main() {
  local command="${1:-help}"
  shift || true

  if [[ "$command" != "doctor" ]]; then
    rae_resolve_python || exit 1
  fi

  case "$command" in
  help | -h | --help)
    usage
    ;;
  verify)
    run_verify "$@"
    ;;
  doctor)
    run_doctor "$@"
    ;;
  agent | autonomous)
    run_agent "$@"
    ;;
  graph)
    run_graph "$@"
    ;;
  operator | console)
    run_operator "$@"
    ;;
  task)
    run_task "$@"
    ;;
  checkpoint)
    run_checkpoint "$@"
    ;;
  orchestrate | orchestration)
    run_orchestration "$@"
    ;;
  worktree)
    run_worktree "$@"
    ;;
  ralph)
    run_ralph "$@"
    ;;
  hygiene)
    run_hygiene "$@"
    ;;
  eval | evals)
    run_eval "$@"
    ;;
  release-gate)
    run_eval release-gate "$@"
    ;;
  workflow | workflows)
    run_workflow "$@"
    ;;
  *)
    die "unknown command: $command"
    ;;
  esac
}

main "$@"
