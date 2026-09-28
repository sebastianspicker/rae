# shellcheck shell=bash
# Shared helpers for scripts that parse optional flags.
# Source this from scripts/ then define usage() and use usage_exit / unknown_opt as needed.
# shellcheck disable=SC2120
usage_exit() {
  if [[ $# -ge 1 ]]; then
    printf '%s\n' "$1" >&2
  fi
  if declare -f usage >/dev/null 2>&1; then
    usage >&2
  fi
  exit 1
}

unknown_opt() {
  usage_exit "unknown argument: $1"
}
