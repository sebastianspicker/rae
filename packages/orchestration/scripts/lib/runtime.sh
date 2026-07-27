# shellcheck shell=bash
# Provides the Bash and Python runtime gate shared by orchestration shell entrypoints.

ORCHESTRATION_MIN_BASH_MAJOR=5
ORCHESTRATION_MIN_BASH_MINOR=3

orchestration_require_bash() {
  if ((BASH_VERSINFO[0] > ORCHESTRATION_MIN_BASH_MAJOR)) ||
    ((BASH_VERSINFO[0] == ORCHESTRATION_MIN_BASH_MAJOR &&
      BASH_VERSINFO[1] >= ORCHESTRATION_MIN_BASH_MINOR)); then
    return 0
  fi
  printf 'ERROR: GNU Bash 5.3 or newer is required; running %s\n' "$BASH_VERSION" >&2
  return 1
}

orchestration_resolve_python() {
  local candidate detected_version=""
  for candidate in "${PYTHON_BIN:-}" python3 python; do
    [[ -n "$candidate" ]] || continue
    candidate="$(command -v "$candidate" 2>/dev/null || true)"
    [[ -n "$candidate" ]] || continue
    detected_version="$("$candidate" -c 'import sys; print(".".join(map(str, sys.version_info[:3])))' 2>/dev/null || true)"
    if "$candidate" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 14, 6) else 1)'; then
      export PYTHON_BIN="$candidate"
      return 0
    fi
  done
  printf 'ERROR: Python 3.14.6 or newer is required; found %s\n' \
    "${detected_version:-no usable interpreter}" >&2
  return 1
}

orchestration_require_runtime() {
  orchestration_require_bash
  orchestration_resolve_python
}
