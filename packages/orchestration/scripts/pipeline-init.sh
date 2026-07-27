#!/usr/bin/env bash
# Creates or safely cleans pipeline-owned worktrees while enforcing ownership and path boundaries.
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/runtime.sh
source "$script_dir/lib/runtime.sh"
orchestration_require_runtime

usage() {
  cat <<'EOF'
Usage: ./scripts/pipeline-init.sh [project-root] [--use-worktree] [--worktree-root <path>] [--branch-prefix <prefix>]
       ./scripts/pipeline-init.sh --cleanup-worktree <path>

Options:
  --use-worktree            Create a dedicated git worktree for the run.
  --worktree-root <path>    Parent directory for worktrees. Default: <git-root>/.worktrees
  --branch-prefix <prefix>  Branch prefix for isolated worktrees. Default: pipeline
  --cleanup-worktree <path> Remove a clean, pipeline-owned worktree and its branch. Idempotent.
  -h, --help                Show this help.
EOF
}

canonical_path() {
  local path="$1"
  if command -v realpath >/dev/null 2>&1; then
    realpath "$path" 2>/dev/null && return 0
  fi
  "$PYTHON_BIN" - <<'PY' "$path"
import os, sys
print(os.path.realpath(sys.argv[1]))
PY
}

json_field() {
  local json_path="$1"
  local key_path="$2"
  "$PYTHON_BIN" - <<'PY' "$json_path" "$key_path"
import json, sys
path, key_path = sys.argv[1], sys.argv[2]
with open(path, encoding="utf-8") as handle:
    data = json.load(handle)
value = data
for key in key_path.split("."):
    if value is None:
        break
    value = value.get(key) if isinstance(value, dict) else None
if value is None:
    print("")
elif isinstance(value, bool):
    print("true" if value else "false")
else:
    print(value)
PY
}

json_string() {
  "$PYTHON_BIN" - <<'PY' "$1"
import json, sys
print(json.dumps(sys.argv[1]))
PY
}

load_cleanup_state() {
  local state_path="$1"
  # shellcheck disable=SC2178 # The second argument names an associative array.
  local -n state_ref="$2"
  state_ref["primary_repo_root"]="$(json_field "$state_path" "workspace.primary_repo_root")"
  state_ref["worktree_root"]="$(json_field "$state_path" "workspace.worktree_root")"
  state_ref["declared_worktree"]="$(json_field "$state_path" "workspace.worktree_path")"
  state_ref["marker"]="$(json_field "$state_path" "workspace.ownership_marker")"
  state_ref["branch_name"]="$(json_field "$state_path" "workspace.branch")"
}

# Cleanup accepts only an ownership record that confines the requested path to its declared root.
validate_cleanup_state() {
  local worktree_path="$1"
  # shellcheck disable=SC2178 # The second argument names an associative array.
  local -n state_ref="$2"
  [[ "${state_ref[marker]}" == "rae-pipeline-worktree-v1" ]] || {
    echo "ERROR: refusing cleanup: worktree is not marked as pipeline-owned" >&2
    return 1
  }
  [[ -n "${state_ref[primary_repo_root]}" &&
    -n "${state_ref[worktree_root]}" &&
    -n "${state_ref[declared_worktree]}" &&
    -n "${state_ref[branch_name]}" ]] || {
    echo "ERROR: refusing cleanup: incomplete pipeline ownership state" >&2
    return 1
  }

  state_ref[primary_repo_root]="$(canonical_path "${state_ref[primary_repo_root]}")"
  state_ref[worktree_root]="$(canonical_path "${state_ref[worktree_root]}")"
  state_ref[declared_worktree]="$(canonical_path "${state_ref[declared_worktree]}")"
  [[ "${state_ref[declared_worktree]}" == "$worktree_path" ]] || {
    echo "ERROR: refusing cleanup: target does not match owned worktree path" >&2
    return 1
  }
  [[ "$worktree_path" == "${state_ref[worktree_root]}"/* ]] || {
    echo "ERROR: refusing cleanup: target is outside owned worktree root" >&2
    return 1
  }
}

validate_cleanup_registration() {
  local worktree_path="$1"
  # shellcheck disable=SC2178 # The second argument names an associative array.
  local -n state_ref="$2"
  local actual_branch
  git -C "${state_ref[primary_repo_root]}" rev-parse --is-inside-work-tree >/dev/null 2>&1 || {
    echo "ERROR: refusing cleanup: primary repository is unavailable" >&2
    return 1
  }
  git -C "${state_ref[primary_repo_root]}" worktree list --porcelain |
    grep -Fqx "worktree $worktree_path" || {
    echo "ERROR: refusing cleanup: target is not registered by the primary repository" >&2
    return 1
  }
  actual_branch="$(git -C "$worktree_path" branch --show-current 2>/dev/null || true)"
  [[ "$actual_branch" == "${state_ref[branch_name]}" ]] || {
    echo "ERROR: refusing cleanup: branch ownership does not match" >&2
    return 1
  }
}

validate_cleanup_contents() {
  local worktree_path="$1"
  local untracked_path
  # Never discard tracked changes, including tracked files below .pipeline.
  if ! git -C "$worktree_path" diff --quiet --ignore-submodules -- . \
    || ! git -C "$worktree_path" diff --cached --quiet --ignore-submodules -- .; then
    echo "ERROR: refusing cleanup: owned worktree has uncommitted changes" >&2
    return 1
  fi

  # The ownership state authorizes only the pipeline runtime namespace. Any
  # other ignored or untracked file may belong to the operator and must keep the
  # worktree alive.
  while IFS= read -r -d '' untracked_path; do
    case "$untracked_path" in
      .pipeline/pipeline-state.json | .pipeline/runs/* | .pipeline/evaluations/*) ;;
      *)
        echo "ERROR: refusing cleanup: owned worktree has uncommitted changes at: $untracked_path" >&2
        return 1
        ;;
    esac
  done < <(
    git -C "$worktree_path" ls-files --others --exclude-standard -z
    git -C "$worktree_path" ls-files --others --ignored --exclude-standard -z
  )
}

remove_owned_worktree() {
  local worktree_path="$1"
  # shellcheck disable=SC2178 # The second argument names an associative array.
  local -n state_ref="$2"
  git -C "${state_ref[primary_repo_root]}" merge-base \
    --is-ancestor "refs/heads/${state_ref[branch_name]}" HEAD || {
    echo "ERROR: refusing cleanup: owned branch has commits not merged into the primary branch" >&2
    return 1
  }
  git -C "${state_ref[primary_repo_root]}" worktree remove --force "$worktree_path"
  git -C "${state_ref[primary_repo_root]}" branch -d -- "${state_ref[branch_name]}"
}

# Never delete an arbitrary worktree: cleanup requires a valid pipeline-owned state record.
cleanup_worktree() {
  local target="$1"
  local worktree_path state_path
  local -A state=()
  worktree_path="$(canonical_path "$target")"
  if [[ ! -e "$worktree_path" ]]; then
    echo "Worktree cleanup:"
    echo "  worktree_path: $worktree_path"
    echo "  status:        already-absent"
    return 0
  fi

  state_path="$worktree_path/.pipeline/pipeline-state.json"
  [[ -f "$state_path" ]] || {
    echo "ERROR: refusing cleanup: missing pipeline ownership state at $state_path" >&2
    return 1
  }
  load_cleanup_state "$state_path" state
  validate_cleanup_state "$worktree_path" state
  validate_cleanup_registration "$worktree_path" state
  validate_cleanup_contents "$worktree_path"
  remove_owned_worktree "$worktree_path" state

  echo "Worktree cleanup:"
  echo "  worktree_path: $worktree_path"
  echo "  branch:        ${state[branch_name]:-unknown}"
  echo "  status:        removed"
}

project_root="."
use_worktree="false"
worktree_root=""
branch_prefix="pipeline"
cleanup_target=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --use-worktree)
      use_worktree="true"
      shift
      ;;
    --worktree-root)
      worktree_root="${2:?missing value for --worktree-root}"
      shift 2
      ;;
    --branch-prefix)
      branch_prefix="${2:?missing value for --branch-prefix}"
      shift 2
      ;;
    --cleanup-worktree)
      cleanup_target="${2:?missing value for --cleanup-worktree}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    --*)
      echo "ERROR: unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
    *)
      project_root="$1"
      shift
      ;;
  esac
done

if [[ -n "$cleanup_target" ]]; then
  cleanup_worktree "$cleanup_target"
  exit 0
fi

project_root="$(canonical_path "$project_root")"
script_path="$(canonical_path "${BASH_SOURCE[0]}")"
workspace_root="$project_root"
primary_repo_root="$project_root"
workspace_mode="main-repo"
branch_name="$(git -C "$project_root" branch --show-current 2>/dev/null || true)"
worktree_path_json="null"
worktree_root_json="null"
ownership_marker_json="null"
cleanup_command_json="null"

run_id="$(uuidgen 2>/dev/null || "$PYTHON_BIN" -c 'import uuid; print(uuid.uuid4())' 2>/dev/null || date +%s)"
run_id="$(echo "$run_id" | tr '[:upper:]' '[:lower:]')"

if [[ "$use_worktree" == "true" ]]; then
  git_repo_root="$(git -C "$project_root" rev-parse --show-toplevel 2>/dev/null || true)"
  [[ -n "$git_repo_root" ]] || {
    echo "ERROR: --use-worktree requires a git repository" >&2
    exit 1
  }
  primary_repo_root="$(canonical_path "$git_repo_root")"
  workspace_mode="git-worktree"
  if [[ -z "$worktree_root" ]]; then
    worktree_root="$primary_repo_root/.worktrees"
  fi
  mkdir -p "$worktree_root"
  worktree_root="$(canonical_path "$worktree_root")"
  branch_name="${branch_prefix}/${run_id}"
  workspace_root="$worktree_root/$run_id"
  git -C "$primary_repo_root" worktree add -b "$branch_name" "$workspace_root" HEAD >/dev/null
  worktree_path_json="$(json_string "$workspace_root")"
  worktree_root_json="$(json_string "$worktree_root")"
  ownership_marker_json="$(json_string "rae-pipeline-worktree-v1")"
  cleanup_command_json="$(json_string "bash \"$script_path\" --cleanup-worktree \"$workspace_root\"")"
fi

pipeline_dir="$workspace_root/.pipeline"
run_dir="$pipeline_dir/runs/$run_id"

mkdir -p "$run_dir/drift-reports"
mkdir -p "$run_dir/quality-reports"
mkdir -p "$run_dir/gates"
mkdir -p "$run_dir/evaluations"

timestamp="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
trace_path="$run_dir/trace.jsonl"
timestamp_json="$(json_string "$timestamp")"
run_id_json="$(json_string "$run_id")"
workspace_mode_json="$(json_string "$workspace_mode")"
workspace_root_json="$(json_string "$workspace_root")"
primary_repo_root_json="$(json_string "$primary_repo_root")"
branch_name_json="$(json_string "$branch_name")"

printf '{"ts":%s,"run_id":%s,"event":"run_start","phase":"arm","status":"ok","metadata":{"source":"pipeline-init","workspace_mode":%s,"workspace_root":%s,"primary_repo_root":%s,"branch":%s}}\n' \
  "$timestamp_json" \
  "$run_id_json" \
  "$workspace_mode_json" \
  "$workspace_root_json" \
  "$primary_repo_root_json" \
  "$branch_name_json" > "$trace_path"

cat > "$pipeline_dir/pipeline-state.json" <<EOF
{
  "run_id": $run_id_json,
  "created_at": $timestamp_json,
  "current_phase": "arm",
  "workspace": {
    "mode": $workspace_mode_json,
    "root": $workspace_root_json,
    "primary_repo_root": $primary_repo_root_json,
    "branch": $branch_name_json,
    "worktree_path": $worktree_path_json,
    "worktree_root": $worktree_root_json,
    "ownership_marker": $ownership_marker_json,
    "cleanup_command": $cleanup_command_json
  },
  "phase_order": [
    "arm",
    "design",
    "adversarial-review",
    "plan",
    "pmatch",
    "build",
    "quality-static",
    "quality-tests",
    "post-build",
    "release-readiness"
  ],
  "completed_gates": [],
  "artifacts": {
    "brief": null,
    "design": null,
    "review": null,
    "review_loop": null,
    "plan": null,
    "build": null,
    "post_build": null,
    "release_readiness": null,
    "progress_summary": null,
    "drift_reports": [],
    "quality_reports": []
  },
  "config": {
    "cognitive_tiers": {
      "arm": "high_reasoning",
      "design": "balanced",
      "adversarial_review_lead": "high_reasoning",
      "adversarial_review_reviewers": "fast",
      "plan": "balanced",
      "pmatch_extractors": "fast",
      "pmatch_adjudicator": "balanced",
      "build_lead": "balanced",
      "build_worker": "fast",
      "quality_static": "fast",
      "quality_tests": "fast",
      "post_build": "fast",
      "release_readiness": "high_reasoning"
    },
    "activity_assignments": {
      "arm_briefing": {
        "tier": "high_reasoning",
        "model_hint": "brief-architect",
        "runtime_name": "default",
        "runtime_version": "v1"
      },
      "design_synthesis": {
        "tier": "balanced",
        "model_hint": "design-synthesizer",
        "runtime_name": "default",
        "runtime_version": "v1"
      },
      "adversarial_review_lead": {
        "tier": "high_reasoning",
        "model_hint": "review-lead",
        "runtime_name": "default",
        "runtime_version": "v1"
      },
      "plan_synthesis": {
        "tier": "balanced",
        "model_hint": "plan-synthesizer",
        "runtime_name": "default",
        "runtime_version": "v1"
      },
      "pmatch_adjudicator": {
        "tier": "balanced",
        "model_hint": "drift-adjudicator",
        "runtime_name": "default",
        "runtime_version": "v1"
      },
      "build_worker": {
        "tier": "fast",
        "model_hint": "build-worker",
        "runtime_name": "default",
        "runtime_version": "v1"
      },
      "quality_static": {
        "tier": "fast",
        "model_hint": "quality-static",
        "runtime_name": "default",
        "runtime_version": "v1"
      },
      "quality_tests_case": {
        "tier": "fast",
        "model_hint": "quality-tests",
        "runtime_name": "default",
        "runtime_version": "v1"
      },
      "post_build": {
        "tier": "fast",
        "model_hint": "post-build",
        "runtime_name": "default",
        "runtime_version": "v1"
      },
      "release_readiness": {
        "tier": "high_reasoning",
        "model_hint": "release-readiness",
        "runtime_name": "default",
        "runtime_version": "v1"
      }
    },
    "post_build": [
      "denoise",
      "quality-frontend",
      "quality-backend",
      "quality-docs",
      "security-review"
    ],
    "context_budgets": {
      "design": 24000,
      "adversarial-review": 18000,
      "plan": 16000,
      "pmatch": 12000,
      "build_lead": 10000,
      "build_worker": 8000
    },
    "feature_flags": {
      "trace_v1": true,
      "evaluation_v1": true,
      "context_budget_v1": true,
      "traceability_v1": true,
      "drift_benchmark_v1": true,
      "worktree_isolation_v1": $use_worktree,
      "activity_routing_v1": true
    }
  }
}
EOF

echo "Pipeline initialized:"
echo "  run_id:         $run_id"
echo "  workspace_mode: $workspace_mode"
echo "  workspace_root: $workspace_root"
echo "  primary_root:   $primary_repo_root"
echo "  branch:         $branch_name"
echo "  run_dir:        $run_dir"
echo "  trace:          $trace_path"
echo "  state:          $pipeline_dir/pipeline-state.json"
echo ""
echo "Next step:"
if [[ "$use_worktree" == "true" ]]; then
  echo "  cd \"$workspace_root\" && node scripts/pipeline/runner.mjs run-stage --run-id $run_id --phase arm"
else
  echo "  node scripts/pipeline/runner.mjs run-stage --run-id $run_id --phase arm"
fi
