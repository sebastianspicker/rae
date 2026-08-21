#!/usr/bin/env bash
# Runs the orchestration package verification gates before changes are accepted.
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/runtime.sh
source "$script_dir/lib/runtime.sh"
orchestration_require_bash

SKIP_INSTALL=0
PARALLEL=0
CHANGED_ONLY=0
CHANGED_BASE="HEAD"
SECONDS=0

while (($# > 0)); do
  case "$1" in
  --skip-install)
    SKIP_INSTALL=1
    ;;
  --parallel)
    PARALLEL=1
    ;;
  --changed-only)
    CHANGED_ONLY=1
    ;;
  --changed-base=*)
    CHANGED_BASE="${1#--changed-base=}"
    ;;
  --changed-base)
    shift
    if (($# == 0)) || [[ "$1" == --* ]]; then
      echo "ERROR: missing value for --changed-base" >&2
      exit 2
    fi
    CHANGED_BASE="$1"
    ;;
  *)
    printf 'ERROR: unknown verification option: %s\n' "$1" >&2
    exit 2
    ;;
  esac
  shift
done

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
orchestration_resolve_python
export PYTHONDONTWRITEBYTECODE=1
export NPM_CONFIG_CACHE="${NPM_CONFIG_CACHE:-$root_dir/.cache/npm}"

# Color output (only when stdout is a terminal)
if [ -t 1 ]; then
  GREEN='\033[0;32m'; RED='\033[0;31m'; BOLD='\033[1m'; NC='\033[0m'
else
  GREEN=''; RED=''; BOLD=''; NC=''
fi

step_ok()   { echo -e "${GREEN}PASS${NC}: $1"; }
step_fail() { echo -e "${RED}FAIL${NC}: $1"; }
step_info() { echo -e "${BOLD}==> $1${NC}"; }

run_core_checks() {
  "$PYTHON_BIN" "$root_dir/scripts/skills/validate_skills.py" --manifest "$root_dir/adapters/spec/adapter-manifest.json"
  "$root_dir/scripts/check-no-stale-refs.sh"
  "$root_dir/scripts/check-repo-hygiene.sh"
  "$PYTHON_BIN" "$root_dir/scripts/check-markdown-links.py" --root "$root_dir" --allowed-root "$root_dir/../.." --strict
  "$root_dir/scripts/check-adapter-sync.sh"
  "$root_dir/scripts/check-orchestration-integrity.sh"
}

collect_changed_paths() {
  local base="$1"
  local diff_paths
  local untracked
  diff_paths="$(git -C "$root_dir" diff --name-only "$base" -- . || true)"
  untracked="$(git -C "$root_dir" ls-files --others --exclude-standard || true)"
  printf "%s\n%s\n" "$diff_paths" "$untracked" | sed '/^$/d' | sort -u
}

verification_scope_for_path() {
  local path="$1"
  case "$path" in
  skills/dev-tools/quality-gate/*)
    printf '%s\n' "skills/dev-tools/quality-gate"
    ;;
  skills/dev-tools/multi-model-review/*)
    printf '%s\n' "skills/dev-tools/multi-model-review"
    ;;
  skills/dev-tools/trace-collector/*)
    printf '%s\n' "skills/dev-tools/trace-collector"
    ;;
  skills/dev-tools/_shared/* | contracts/* | biome.json | scripts/verify.sh | scripts/pipeline/* | scripts/lib/* | scripts/skills/*)
    printf '%s\n' "ALL_PACKAGES"
    ;;
  esac
}

selected_packages_from_changes() {
  local base="$1"
  local changed_paths path scope
  local -a package_set=()

  if ! git -C "$root_dir" rev-parse --verify "$base" >/dev/null 2>&1; then
    echo "WARN: --changed-base '$base' not found; falling back to full package verification" >&2
    printf "%s\n" "ALL_PACKAGES"
    return 0
  fi

  changed_paths="$(collect_changed_paths "$base")"
  if [[ -z "$changed_paths" ]]; then
    printf "%s\n" "NO_PACKAGE_CHANGES"
    return 0
  fi

  while IFS= read -r path; do
    [[ -z "$path" ]] && continue
    scope="$(verification_scope_for_path "$path")"
    [[ -n "$scope" ]] || continue
    if [[ "$scope" == "ALL_PACKAGES" ]]; then
      printf '%s\n' "$scope"
      return 0
    fi
    package_set+=("$scope")
  done <<< "$changed_paths"

  if [[ "${#package_set[@]}" -eq 0 ]]; then
    printf "%s\n" "NO_PACKAGE_CHANGES"
    return 0
  fi

  printf "%s\n" "${package_set[@]}" | sort -u
}

run_core_checks

# Install workspace dependencies early (needed by runner lib tests and package verification)
if [ "$SKIP_INSTALL" -eq 0 ]; then
  echo "==> npm ci (workspaces)"
  (cd "$root_dir" && npm ci)
  echo "==> npm audit (workspaces)"
  (cd "$root_dir" && npm audit --audit-level=moderate)
fi

# Build skill packages (required by runner-stage integration tests)
step_info "build skill packages"
for pkg in skills/dev-tools/_shared skills/dev-tools/quality-gate skills/dev-tools/multi-model-review skills/dev-tools/trace-collector; do
  (cd "$root_dir/$pkg" && npm run build) || { step_fail "build $pkg"; exit 1; }
done
step_ok "skill packages built"

# Runner CLI smoke test
step_info "runner CLI smoke test"
node "$root_dir/scripts/pipeline/runner.mjs" --help >/dev/null 2>&1 || { step_fail "runner CLI smoke test"; exit 1; }
node "$root_dir/scripts/pipeline/autonomous.mjs" --help >/dev/null 2>&1 || { step_fail "autonomous CLI smoke test"; exit 1; }
step_ok "runner CLI loads successfully"

# Compact runner boundary tests
step_info "runner lib tests"
(cd "$root_dir/scripts/pipeline" && "$root_dir/node_modules/.bin/vitest" run --reporter=verbose tests/argv-security.test.mjs tests/agent-provider-event-log-security.test.mjs tests/operator-cli.test.mjs 2>&1) || { step_fail "runner lib tests"; exit 1; }
step_ok "runner lib tests passed"

# Operator security boundary uses Node's test runner.
step_info "operator tests"
(cd "$root_dir" && node --test operator/tests/security.test.mjs 2>&1) || { step_fail "operator tests"; exit 1; }
step_ok "operator tests passed"

export SKIP_INSTALL
export root_dir

verify_pkg() {
  local pkg="$1"
  echo "==> verify $pkg"
  (
    cd "$root_dir/$pkg"
    npm run lint
    npm run format:check
    npm run build
  )
}
export -f verify_pkg

verify_shared() {
  local pkg="skills/dev-tools/_shared"
  echo "==> verify $pkg"
  (
    cd "$root_dir/$pkg"
    npm run lint
    npm run format:check
    npm run build
  )
}

packages=(
  "skills/dev-tools/quality-gate"
  "skills/dev-tools/multi-model-review"
  "skills/dev-tools/trace-collector"
)

if [ "$CHANGED_ONLY" -eq 1 ]; then
  selection="$(selected_packages_from_changes "$CHANGED_BASE")"
  if [[ "$selection" == "ALL_PACKAGES" ]]; then
    :
  elif [[ "$selection" == "NO_PACKAGE_CHANGES" ]]; then
    packages=()
  else
    mapfile -t packages <<< "$selection"
  fi
fi

if [ ${#packages[@]} -eq 0 ]; then
  echo "==> verify runtime packages (skipped: no relevant package changes)"
else
  verify_shared
fi

if [ ${#packages[@]} -eq 0 ]; then
  :
elif [ "$PARALLEL" -eq 1 ] && [ ${#packages[@]} -gt 1 ]; then
  # shellcheck disable=SC2016
  printf "%s\n" "${packages[@]}" | xargs -n 1 -P 3 bash -c 'verify_pkg "$1"' _
else
  for pkg in "${packages[@]}"; do
    verify_pkg "$pkg"
  done
fi

step_info "verify summary"
if [ "$CHANGED_ONLY" -eq 1 ]; then
  echo "mode: changed-only (base=$CHANGED_BASE)"
else
  echo "mode: full"
fi
if [ ${#packages[@]} -eq 0 ]; then
  echo "packages: none"
else
  echo "packages: ${packages[*]}"
fi
echo -e "duration_s: ${BOLD}${SECONDS}${NC}"
step_ok "all checks passed"
