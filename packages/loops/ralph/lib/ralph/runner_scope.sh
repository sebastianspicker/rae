# shellcheck shell=bash
# Small state helpers retained by runner persistence.

file_signature_or_missing() {
  local path="$1"
  local signature
  if [[ -f "$path" ]]; then
    if ! signature="$(file_state_signature "$path")"; then
      fail "Could not read file metadata for: $path"
    fi
    printf '%s' "$signature"
  else
    printf '__missing__'
  fi
}
