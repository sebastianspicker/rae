#!/usr/bin/env bash
set -euo pipefail

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if ! command -v rg >/dev/null 2>&1; then
  echo "ERROR: ripgrep (rg) is required for stale-ref checks." >&2
  exit 2
fi

declare -a patterns=(
  "skills/dev-tools/ts-optimize"
  "skills/dev-tools/ps1-optimize"
  "dev-tools.ts-optimize"
  "dev-tools.ps1-optimize"
  "agents/dev-tools/"
  "Haiku proxy"
  "Kimi API"
  "GLM API"
)

declare -a rg_args=(
  --fixed-strings
  --no-messages
  --line-number
  --smart-case
  --glob "!_archive/**"
  --glob "!.codex/skills-archive/**"
  --glob "!.pipeline/**"
  --glob "!**/node_modules/**"
  --glob "!**/dist/**"
  --glob "!**/.git/**"
  --glob "!scripts/check-no-stale-refs.sh"
)

declare -a expr_args=()
for p in "${patterns[@]}"; do
  expr_args+=(-e "$p")
done

matches="$(
  cd "$root_dir"
  rg "${rg_args[@]}" "${expr_args[@]}" . || true
)"

if [[ -n "${matches}" ]]; then
  echo "FAIL: stale references detected (should be archived-only):" >&2
  echo "${matches}" >&2
  echo >&2
  echo "If intentional, move the reference into \`_archive/\` or \`.codex/skills-archive/\`." >&2
  exit 1
fi

echo "OK: no stale references found"
