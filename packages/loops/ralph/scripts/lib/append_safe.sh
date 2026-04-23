# shellcheck shell=bash
# Append content to a file atomically (temp file + mv). Caller must have mktemp available (e.g. compat sourced).
# Usage: append_safe_to_file <target_file> [content]
#   With one argument: append stdin to target_file.
#   With two arguments: append second argument (may contain newlines) to target_file.
#   If target_file does not exist, it is created (then content is appended).
#   Rejects target_file containing ".." to prevent path traversal.

append_safe_to_file() {
  local target="$1"
  local target_dir target_dir_real target_abs append_root root_real
  local probe probe_parent probe_real
  local tmp_file
  case "$target" in
  *".."*)
    printf '[ralph] append_safe: rejecting path with "..": %s\n' "$target" >&2
    exit 1
    ;;
  esac
  case "$target" in
  /*) target_abs="$target" ;;
  *) target_abs="$(pwd -P)/$target" ;;
  esac
  target_dir="$(dirname "$target_abs")"
  probe="$target_dir"
  while [[ ! -e "$probe" && ! -L "$probe" ]]; do
    probe_parent="$(dirname "$probe")"
    [[ "$probe_parent" != "$probe" ]] || break
    probe="$probe_parent"
  done
  probe_real="$(cd "$probe" && pwd -P)"
  if [[ -n "${RALPH_APPEND_ROOT:-}" ]]; then
    append_root="$RALPH_APPEND_ROOT"
    root_real="$(cd "$append_root" && pwd -P)"
    case "$probe_real" in
    "$root_real" | "$root_real"/*) ;;
    *)
      printf '[ralph] append_safe: rejecting path outside append root: %s\n' "$target" >&2
      exit 1
      ;;
    esac
  fi
  mkdir -p "$target_dir"
  target_dir_real="$(cd "$target_dir" && pwd -P)"
  target_abs="${target_dir_real}/$(basename "$target_abs")"
  if [[ -n "${RALPH_APPEND_ROOT:-}" ]]; then
    case "$target_abs" in
    "$root_real" | "$root_real"/*) ;;
    *)
      printf '[ralph] append_safe: rejecting path outside append root: %s\n' "$target" >&2
      exit 1
      ;;
    esac
  fi
  if [[ -L "$target" ]]; then
    printf '[ralph] append_safe: rejecting symlink target: %s\n' "$target" >&2
    exit 1
  fi
  tmp_file="$(mktemp "${target}.XXXXXX.tmp")"
  trap 'rm -f "$tmp_file"' RETURN
  if [[ -f "$target" ]]; then
    cat "$target" >"$tmp_file"
  else
    : >"$tmp_file"
  fi
  if [[ $# -ge 2 ]]; then
    printf '%s\n' "$2" >>"$tmp_file"
  else
    cat >>"$tmp_file"
  fi
  mv "$tmp_file" "$target"
}
