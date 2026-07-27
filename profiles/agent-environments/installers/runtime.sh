#!/usr/bin/env bash
# Runtime contract shared by the profile entry points and its shell tests.

rae_require_runtime() {
  if (( BASH_VERSINFO[0] < 5 || (BASH_VERSINFO[0] == 5 && BASH_VERSINFO[1] < 3) )); then
    printf 'Bash 5.3 or newer is required (found %s)\n' "$BASH_VERSION" >&2
    return 1
  fi
  local candidate version
  for candidate in "${PYTHON_BIN:-}" python3 python; do
    [[ -n "$candidate" ]] || continue
    command -v "$candidate" >/dev/null 2>&1 || continue
    version="$("$candidate" -c 'import sys; print(".".join(map(str, sys.version_info[:3])))')"
    if "$candidate" -c 'import sys; raise SystemExit(sys.version_info < (3, 14, 6))'; then
      PYTHON_BIN="$candidate"
      export PYTHON_BIN
      return 0
    fi
  done
  printf 'Python 3.14.6 or newer is required (found %s)\n' "${version:-unavailable}" >&2
  return 1
}
