# shellcheck shell=bash
# Report aggregation: summarize all reports under report_dir into a single file.

aggregate_reports() {
  local report_dir_base report_dir_abs report_dir_real summary_file summary_rel tmp_summary
  # Reject path traversal and absolute paths in DEFAULT_REPORT_DIR.
  case "$DEFAULT_REPORT_DIR" in
  *".."* | /*) fail "${RALPH_EXIT_GENERAL:-1}" "defaults.report_dir must not contain '..' or be absolute" "Set defaults.report_dir in prd.json to a relative path without '..'" ;;
  esac
  report_dir_base="${SCRIPT_DIR}/${DEFAULT_REPORT_DIR}"

  if [[ ! -d "$report_dir_base" ]]; then
    log "No report directory at $report_dir_base; skipping aggregation."
    return 0
  fi

  report_dir_real="$(resolve_effective_target_path "$report_dir_base")" || fail "Could not resolve report directory path: $report_dir_base"
  report_dir_abs="$(cd "$(dirname "$report_dir_base")" && pwd -P)/$(basename "$report_dir_base")"
  if [[ "$report_dir_real" != "$report_dir_abs" ]]; then
    fail "Report directory must not resolve through symlinks: $DEFAULT_REPORT_DIR"
  fi
  if ! is_path_within_root "$REPO_ROOT_REAL" "$report_dir_real"; then
    fail "Report directory resolves outside repository: $DEFAULT_REPORT_DIR"
  fi

  summary_file="${report_dir_real}/summary.md"
  summary_rel="${DEFAULT_REPORT_DIR%/}/summary.md"
  summary_rel="${summary_rel#./}"
  [[ -n "$summary_rel" ]] || summary_rel="summary.md"
  enforce_report_target_confinement "$summary_file" "$summary_rel"
  tmp_summary="$(mktemp "${report_dir_real}/.ralph-summary.XXXXXX.tmp")"
  register_tmp "$tmp_summary"

  {
    printf '# Ralph Reports Summary\n\n'
    printf 'Generated at (UTC): %s\n\n' "$(ralph_iso_utc)"
    printf '## Reports\n\n'
    "$PYTHON_EXECUTABLE" - "$report_dir_real" <<'PY'
from pathlib import Path
import sys

base = Path(sys.argv[1])
paths = sorted(
    path.relative_to(base).as_posix()
    for path in base.rglob("*.md")
    if path.name != "summary.md"
)
for rel in paths:
    print(f"- [{rel}]({rel})")
PY
    printf '\n'
  } >"$tmp_summary"

  enforce_report_target_confinement "$summary_file" "$summary_rel"
  mv "$tmp_summary" "$summary_file"

  log "Wrote report summary to $summary_file"
}
