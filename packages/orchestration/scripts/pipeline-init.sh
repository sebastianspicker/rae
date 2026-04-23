#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: ./scripts/pipeline-init.sh [project-root] [--use-worktree] [--worktree-root <path>] [--branch-prefix <prefix>]
       ./scripts/pipeline-init.sh --cleanup-worktree <path>

Options:
  --use-worktree            Create a dedicated git worktree for the run.
  --worktree-root <path>    Parent directory for worktrees. Default: <git-root>/.worktrees
  --branch-prefix <prefix>  Branch prefix for isolated worktrees. Default: pipeline
  --cleanup-worktree <path> Remove a previously created worktree and its branch. Idempotent.
  -h, --help                Show this help.
EOF
}

canonical_path() {
  local path="$1"
  if command -v realpath >/dev/null 2>&1; then
    realpath "$path" 2>/dev/null && return 0
  fi
  python3 - <<'PY' "$path"
import os, sys
print(os.path.realpath(sys.argv[1]))
PY
}

json_field() {
  local json_path="$1"
  local key_path="$2"
  python3 - <<'PY' "$json_path" "$key_path"
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

cleanup_worktree() {
  local target="$1"
  local worktree_path
  worktree_path="$(canonical_path "$target")"

  if [[ ! -e "$worktree_path" ]]; then
    echo "Worktree cleanup:"
    echo "  worktree_path: $worktree_path"
    echo "  status:        already-absent"
    return 0
  fi

  local state_path="$worktree_path/.pipeline/pipeline-state.json"
  local primary_repo_root=""
  local branch_name=""

  if [[ -f "$state_path" ]]; then
    primary_repo_root="$(json_field "$state_path" "workspace.primary_repo_root")"
    branch_name="$(json_field "$state_path" "workspace.branch")"
  fi

  if [[ -z "$primary_repo_root" ]]; then
    local git_common_dir
    git_common_dir="$(git -C "$worktree_path" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)"
    if [[ -n "$git_common_dir" ]]; then
      primary_repo_root="$(dirname "$git_common_dir")"
    fi
  fi

  if [[ -z "$branch_name" ]]; then
    branch_name="$(git -C "$worktree_path" branch --show-current 2>/dev/null || true)"
  fi

  if [[ -n "$primary_repo_root" ]]; then
    git -C "$primary_repo_root" worktree remove --force "$worktree_path" >/dev/null 2>&1 || true
    if [[ -n "$branch_name" ]]; then
      git -C "$primary_repo_root" branch -D "$branch_name" >/dev/null 2>&1 || true
    fi
  fi

  rm -rf "$worktree_path"

  echo "Worktree cleanup:"
  echo "  worktree_path: $worktree_path"
  echo "  branch:        ${branch_name:-unknown}"
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
workspace_root="$project_root"
primary_repo_root="$project_root"
workspace_mode="main-repo"
branch_name="$(git -C "$project_root" branch --show-current 2>/dev/null || true)"
worktree_path_json="null"
cleanup_command_json="null"

run_id="$(uuidgen 2>/dev/null || python3 -c 'import uuid; print(uuid.uuid4())' 2>/dev/null || date +%s)"
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
  worktree_root="$(canonical_path "$worktree_root")"
  branch_name="${branch_prefix}/${run_id}"
  workspace_root="$worktree_root/$run_id"
  mkdir -p "$worktree_root"
  git -C "$primary_repo_root" worktree add -b "$branch_name" "$workspace_root" HEAD >/dev/null
  worktree_path_json="\"$workspace_root\""
  cleanup_command_json="\"bash scripts/pipeline-init.sh --cleanup-worktree $workspace_root\""
fi

pipeline_dir="$workspace_root/.pipeline"
run_dir="$pipeline_dir/runs/$run_id"

mkdir -p "$run_dir/drift-reports"
mkdir -p "$run_dir/quality-reports"
mkdir -p "$run_dir/gates"
mkdir -p "$run_dir/evaluations"

timestamp="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
trace_path="$run_dir/trace.jsonl"

printf '{"ts":"%s","run_id":"%s","event":"run_start","phase":"arm","status":"ok","metadata":{"source":"pipeline-init","workspace_mode":"%s","workspace_root":"%s","primary_repo_root":"%s","branch":"%s"}}\n' \
  "$timestamp" \
  "$run_id" \
  "$workspace_mode" \
  "$workspace_root" \
  "$primary_repo_root" \
  "$branch_name" > "$trace_path"

cat > "$pipeline_dir/pipeline-state.json" <<EOF
{
  "run_id": "$run_id",
  "created_at": "$timestamp",
  "current_phase": "arm",
  "workspace": {
    "mode": "$workspace_mode",
    "root": "$workspace_root",
    "primary_repo_root": "$primary_repo_root",
    "branch": "$branch_name",
    "worktree_path": $worktree_path_json,
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
    "reviewer_roles": [
      "architect-reviewer",
      "security-engineer",
      "performance-engineer"
    ],
    "post_build": [
      "denoise",
      "quality-frontend",
      "quality-backend",
      "quality-docs",
      "security-review"
    ],
    "orchestration_policy": {
      "max_reviewers": 3,
      "max_builders": 3,
      "latency_budget_s": 3600,
      "budget_usd": 50,
      "lambda": 1,
      "mu": 1,
      "min_expected_gain": 0.1
    },
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
