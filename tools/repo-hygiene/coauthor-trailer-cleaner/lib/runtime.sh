#!/usr/bin/env bash
# Runtime contract for this standalone tool.  Keep it local so copies of the
# tool do not depend on the repository root layout.

readonly COAUTHOR_MIN_BASH_MAJOR=5
readonly COAUTHOR_MIN_BASH_MINOR=3
readonly COAUTHOR_MIN_PYTHON_MAJOR=3
readonly COAUTHOR_MIN_PYTHON_MINOR=14
readonly COAUTHOR_MIN_PYTHON_MICRO=6

coauthor_require_bash() {
  if (( BASH_VERSINFO[0] < COAUTHOR_MIN_BASH_MAJOR )) ||
    (( BASH_VERSINFO[0] == COAUTHOR_MIN_BASH_MAJOR && BASH_VERSINFO[1] < COAUTHOR_MIN_BASH_MINOR )); then
    printf '[error] %s requires Bash >= %s.%s (found %s)\n' \
      "$PROGRAM_NAME" "$COAUTHOR_MIN_BASH_MAJOR" "$COAUTHOR_MIN_BASH_MINOR" "$BASH_VERSION" >&2
    return 1
  fi
}

coauthor_resolve_python() {
  local candidate version
  for candidate in "${PYTHON_BIN:-}" python3 python; do
    [[ -n "$candidate" ]] || continue
    command -v "$candidate" >/dev/null 2>&1 || continue
    version="$("$candidate" -c 'import sys; print(".".join(map(str, sys.version_info[:3])))' 2>/dev/null)" || continue
    if [[ "$version" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)$ ]] &&
      (( BASH_REMATCH[1] > COAUTHOR_MIN_PYTHON_MAJOR ||
        (BASH_REMATCH[1] == COAUTHOR_MIN_PYTHON_MAJOR && BASH_REMATCH[2] > COAUTHOR_MIN_PYTHON_MINOR) ||
        (BASH_REMATCH[1] == COAUTHOR_MIN_PYTHON_MAJOR && BASH_REMATCH[2] == COAUTHOR_MIN_PYTHON_MINOR && BASH_REMATCH[3] >= COAUTHOR_MIN_PYTHON_MICRO) )); then
      PYTHON_BIN="$candidate"
      export PYTHON_BIN
      return 0
    fi
  done
  printf '[error] %s requires Python >= %s.%s.%s\n' \
    "$PROGRAM_NAME" "$COAUTHOR_MIN_PYTHON_MAJOR" "$COAUTHOR_MIN_PYTHON_MINOR" "$COAUTHOR_MIN_PYTHON_MICRO" >&2
  return 1
}

coauthor_require_runtime() {
  coauthor_require_bash && coauthor_resolve_python
}
