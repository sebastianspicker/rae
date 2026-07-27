# shellcheck shell=bash
# Provides the top-level Bash and Python runtime gate shared by repository shell entrypoints.

RAE_MIN_BASH_MAJOR=5
RAE_MIN_BASH_MINOR=3

rae_bash_tuple_ok() {
  local major="$1"
  local minor="$2"
  ((major > RAE_MIN_BASH_MAJOR)) ||
    ((major == RAE_MIN_BASH_MAJOR && minor >= RAE_MIN_BASH_MINOR))
}

rae_bash_version_ok() {
  rae_bash_tuple_ok "${BASH_VERSINFO[0]}" "${BASH_VERSINFO[1]}"
}

rae_require_bash() {
  if rae_bash_version_ok; then
    return 0
  fi
  printf 'ERROR: GNU Bash %s.%s or newer is required; running %s\n' \
    "$RAE_MIN_BASH_MAJOR" "$RAE_MIN_BASH_MINOR" "$BASH_VERSION" >&2
  return 1
}

rae_python_version() {
  local python_bin="$1"
  "$python_bin" -c 'import sys; print(".".join(map(str, sys.version_info[:3])))'
}

rae_python_version_ok() {
  local python_bin="$1"
  "$python_bin" -c '
import sys
raise SystemExit(0 if sys.version_info >= (3, 14, 6) else 1)
'
}

rae_resolve_python() {
  local candidate detected_version=""
  for candidate in "${PYTHON_BIN:-}" python3 python; do
    [[ -n "$candidate" ]] || continue
    candidate="$(command -v "$candidate" 2>/dev/null || true)"
    [[ -n "$candidate" ]] || continue
    detected_version="$(rae_python_version "$candidate" 2>/dev/null || true)"
    if rae_python_version_ok "$candidate"; then
      export PYTHON_BIN="$candidate"
      return 0
    fi
  done
  printf 'ERROR: Python 3.14.6 or newer is required; found %s\n' \
    "${detected_version:-no usable interpreter}" >&2
  return 1
}

rae_require_runtime() {
  rae_require_bash
  rae_resolve_python
}
