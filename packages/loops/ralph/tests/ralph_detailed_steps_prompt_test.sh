#!/usr/bin/env bash
# Regression coverage for Ralph's detailed steps prompt contract.

set -euo pipefail

# shellcheck source=tests/lib/test_helpers.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/test_helpers.sh"

require_cmds jq mktemp

make_fake_tool() {
  local fake_tool="$1"
  cat > "$fake_tool" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

last_message=""
repo=""
for ((ralph_i=1; ralph_i<=$#; ralph_i++)); do
  ralph_arg="${!ralph_i}"
  if [[ "$ralph_arg" == "--output-last-message" ]]; then
    ralph_j=$((ralph_i + 1))
    last_message="${!ralph_j}"
  elif [[ "$ralph_arg" == "-C" ]]; then
    ralph_j=$((ralph_i + 1))
    repo="${!ralph_j}"
  fi
done
[[ -z "$repo" ]] || cd "$repo"
[[ -z "$last_message" ]] || exec >"$last_message"

prompt="$(cat)"

if ! printf '%s' "$prompt" | grep -Fq 'Story objective:'; then
  printf 'missing Story objective section\n' >&2
  exit 11
fi
if ! printf '%s' "$prompt" | grep -Fq 'Execution steps (detailed):'; then
  printf 'missing Execution steps section\n' >&2
  exit 12
fi
if ! printf '%s' "$prompt" | grep -Fq 'Step 1 [S01]:'; then
  printf 'missing first detailed step line\n' >&2
  exit 13
fi
if ! printf '%s' "$prompt" | grep -Fq 'Verification checkpoints:'; then
  printf 'missing verification section\n' >&2
  exit 14
fi
if ! printf '%s' "$prompt" | grep -Fq 'Out of scope:'; then
  printf 'missing out-of-scope section\n' >&2
  exit 15
fi

printf '# detailed prompt report\n'
EOF
  chmod +x "$fake_tool"
}

prepare_repo() {
  local repo_dir="$1"
  prepare_runner_and_tool "$repo_dir"

  cat > "$repo_dir/prd.json" <<'EOF'
{
  "schema_version": "1.0.0",
  "project": "detailed-steps-prompt-test",
  "defaults": {
    "mode_default": "audit",
    "max_stories_default": "all_open",
    "model_default": "gpt-5.3",
    "reasoning_effort_default": "high",
    "report_dir": "audit",
    "sandbox_by_mode": {
      "audit": "read-only",
      "linting": "read-only",
      "fixing": "workspace-write"
    },
    "lint_detection_order": [
      "package.json scripts (lint/test)"
    ]
  },
  "stories": [
    {
      "id": "AUDIT-001",
      "title": "Prompt includes detailed story fields",
      "priority": 1,
      "mode": "audit",
      "scope": ["*", "**/*"],
      "acceptance_criteria": [
        "Created audit/AUDIT-001.md with report"
      ],
      "passes": false,
      "objective": "Verify detailed PRD fields are embedded in generated prompts.",
      "steps": [
        {
          "id": "S01",
          "title": "Render story detail sections",
          "actions": [
            "Inject objective/steps/verification/out_of_scope into prompt."
          ],
          "expected_evidence": [
            "Prompt contains all detailed sections."
          ],
          "done_when": [
            "Prompt shape is deterministic and complete."
          ]
        }
      ],
      "verification": [
        "Prompt includes objective section.",
        "Prompt includes detailed steps section."
      ],
      "out_of_scope": [
        "Code changes in this test fixture."
      ]
    }
  ]
}
EOF
}

run_case() {
  local tmpdir bindir rc
  tmpdir="$(mktemp -d)"
  bindir="$tmpdir/bin"
  mkdir -p "$bindir" "$tmpdir/repo"

  make_fake_tool "$bindir/codex"
  prepare_repo "$tmpdir/repo"

  set +e
  (
    cd "$tmpdir/repo"
    PATH="$bindir:$PATH" MODE=audit ./ralph.sh 1
  ) > "$tmpdir/out.log" 2>&1
  rc=$?
  set -e

  if [[ "$rc" -ne 0 ]]; then
    fail_case "detailed-steps-prompt" "expected success, got rc=$rc" "$tmpdir/out.log" "$tmpdir"
  fi

  if [[ ! -f "$tmpdir/repo/audit/AUDIT-001.md" ]]; then
    fail_case "detailed-steps-prompt" "missing expected report output file" "$tmpdir/out.log" "$tmpdir"
  fi

  cleanup_dir "$tmpdir"
  printf 'PASS [detailed-steps-prompt]\n'
}

run_case
printf 'All detailed prompt tests passed.\n'
