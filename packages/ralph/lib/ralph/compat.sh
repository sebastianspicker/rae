# shellcheck shell=bash
# shellcheck disable=SC2317,SC2329
# Compatibility wrappers for cross-platform support (e.g. Mac mktemp permissions).

ralph_iso_utc() {
  date -u '+%Y-%m-%dT%H:%M:%SZ'
}

ralph_iso_utc_compact() {
  date -u '+%Y%m%dT%H%M%SZ'
}

ralph_mktemp_init() {
  mktemp() {
    local args=("$@")
    local found_template="false"
    local i
    for ((i=0; i<${#args[@]}; i++)); do
      if [[ "${args[i]}" == *"XXXXXX"* ]]; then
        found_template="true"
        if [[ "${args[i]}" != /* ]]; then
          args[i]="/tmp/${args[i]}"
        fi
      fi
    done
    if [[ "$found_template" == "false" ]]; then
      command mktemp "${args[@]}" /tmp/ralph-test.XXXXXX
    else
      command mktemp "${args[@]}"
    fi
  }
}
