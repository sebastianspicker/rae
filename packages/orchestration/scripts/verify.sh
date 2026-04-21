#!/usr/bin/env bash
set -euo pipefail

SKIP_INSTALL=0
PARALLEL=0
CHANGED_ONLY=0
CHANGED_BASE="HEAD"
SECONDS=0

for arg in "$@"; do
  if [ "$arg" == "--skip-install" ]; then
    SKIP_INSTALL=1
  elif [ "$arg" == "--parallel" ]; then
    PARALLEL=1
  elif [ "$arg" == "--changed-only" ]; then
    CHANGED_ONLY=1
  elif [[ "$arg" == --changed-base=* ]]; then
    CHANGED_BASE="${arg#--changed-base=}"
  fi
done

for ((i=1; i<=$#; i++)); do
  if [ "${!i}" == "--changed-base" ]; then
    j=$((i + 1))
    if [ $j -le $# ] && [[ "${!j}" != --* ]]; then
      CHANGED_BASE="${!j}"
    else
      echo "ERROR: missing value for --changed-base" >&2
      exit 2
    fi
  fi
done

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export NPM_CONFIG_CACHE="${NPM_CONFIG_CACHE:-$root_dir/.cache/npm}"

# Color output (only when stdout is a terminal)
if [ -t 1 ]; then
  GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[1;33m'; BOLD='\033[1m'; NC='\033[0m'
else
  GREEN=''; RED=''; YELLOW=''; BOLD=''; NC=''
fi

step_ok()   { echo -e "${GREEN}PASS${NC}: $1"; }
step_fail() { echo -e "${RED}FAIL${NC}: $1"; }
step_info() { echo -e "${BOLD}==> $1${NC}"; }

run_core_checks() {
  python3 "$root_dir/scripts/skills/validate_skills.py" --manifest "$root_dir/adapters/spec/adapter-manifest.json"
  "$root_dir/scripts/check-no-stale-refs.sh"
  "$root_dir/scripts/check-repo-hygiene.sh"
  python3 "$root_dir/scripts/check-markdown-links.py" --root "$root_dir"
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

selected_packages_from_changes() {
  local base="$1"
  local changed_paths
  local full_verify=0
  local pkg_set=()
  local path

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
    case "$path" in
      skills/dev-tools/quality-gate/*)
        pkg_set+=("skills/dev-tools/quality-gate")
        ;;
      skills/dev-tools/multi-model-review/*)
        pkg_set+=("skills/dev-tools/multi-model-review")
        ;;
      skills/dev-tools/trace-collector/*)
        pkg_set+=("skills/dev-tools/trace-collector")
        ;;
      skills/dev-tools/_shared/*|contracts/*|biome.json|scripts/verify.sh|scripts/pipeline/*|scripts/lib/*|scripts/skills/*)
        full_verify=1
        ;;
      *)
        ;;
    esac
  done <<< "$changed_paths"

  if [ $full_verify -eq 1 ]; then
    printf "%s\n" "ALL_PACKAGES"
    return 0
  fi

  if [ ${#pkg_set[@]} -eq 0 ]; then
    printf "%s\n" "NO_PACKAGE_CHANGES"
    return 0
  fi

  printf "%s\n" "${pkg_set[@]}" | sort -u
}

run_core_checks

# Install workspace dependencies early (needed by runner lib tests and package verification)
if [ "$SKIP_INSTALL" -eq 0 ]; then
  echo "==> npm install (workspaces)"
  (cd "$root_dir" && npm install)
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
step_ok "runner CLI loads successfully"

# Runner lib unit tests
step_info "runner lib tests"
(cd "$root_dir/scripts/pipeline" && npx vitest run --reporter=verbose 2>&1) || { step_fail "runner lib tests"; exit 1; }
step_ok "runner lib tests passed"

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
    npm test
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
    npm test
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
  printf "%s\n" "${packages[@]}" | xargs -n 1 -P 3 bash -c 'verify_pkg "$1"' _
else
  for pkg in "${packages[@]}"; do
    verify_pkg "$pkg"
  done
fi

if [[ "${DRIFT_BENCHMARK:-0}" == "1" ]]; then
  echo "==> drift benchmark"
  node "$root_dir/scripts/eval/drift-benchmark.mjs" --root "$root_dir"
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
