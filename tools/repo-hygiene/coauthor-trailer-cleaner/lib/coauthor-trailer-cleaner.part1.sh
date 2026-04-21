# shellcheck shell=bash
# shellcheck disable=SC2034
PROGRAM_NAME="coauthor-trailer-cleaner"
PROGRAM_FILE="coauthor-trailer-cleaner.sh"
VERSION="2.0.0"
BACKUP_BRANCH_PREFIX="backup/coauthor-trailer-cleaner-"
DEFAULT_TARGETS_JSON='[{"name":"Cursor","email":"cursoragent@cursor.com"}]'
TARGETS_JSON="$DEFAULT_TARGETS_JSON"
TARGET_SUMMARY="Cursor <cursoragent@cursor.com>"
MESSAGE_CALLBACK=""

# Global temp files for cleanup (trap removes them on exit)
TEMP_FILES=()
cleanup() {
  if [[ ${#TEMP_FILES[@]} -eq 0 ]]; then
    return
  fi
  local f
  for f in "${TEMP_FILES[@]}"; do
    [[ -f "$f" ]] && rm -f "$f"
  done
}
trap cleanup EXIT

# Colored output when stdout is a TTY and NO_COLOR is unset
use_color=false
if [[ -t 1 && -z "${NO_COLOR:-}" ]]; then
  use_color=true
fi

# Create a temp file and register it for cleanup. Path is stored in CREATED_TEMP_FILE (caller must not use command substitution).
create_temp_file() {
  CREATED_TEMP_FILE=$(mktemp)
  TEMP_FILES+=("$CREATED_TEMP_FILE")
}

# Ensure each required command is on PATH; exit 1 with message if not.
require_command() {
  local cmd
  for cmd in "$@"; do
    if ! command -v "$cmd" >/dev/null 2>&1; then
      log_error "Required command not found: $cmd"
      exit 1
    fi
  done
}

# =============================================================================
# USAGE
# =============================================================================

usage() {
  cat <<'EOF'
Usage:
  coauthor-trailer-cleaner.sh [OPTIONS] [<github_repo_url> <absolute_local_repo_path> ...]
  coauthor-trailer-cleaner.sh [OPTIONS] --repos-file <file>
  coauthor-trailer-cleaner.sh [OPTIONS] --config <config.json>

  URL format: https://github.com/<user>/<repo> or git@github.com:<user>/<repo>

Options:
  --dry-run         Print commands, do not run them (default: false)
  --push            Rewrite history and push to remote (default: false)
  --no-push         Rewrite history locally only; do not push to remote (default: true)
  --force-push      When pushing, use --force (default: true)
  --no-force-push   When pushing, do not use --force
  --validate-only   Run all checks but do not rewrite history or push
  --quiet           Minimal output: one line per repo (pass/fail)
  --verbose         Show every git command (default when not --quiet)
  --target <id>     Remove this co-author identity; repeatable, format: "Name <email>"
  --config <file>   Load defaults and optionally repos from JSON file
  --repos-file <f>  Process repos from file (JSON array or "url path" lines)
  --backup-remote <name>  Before rewriting, push current branch to this remote (skipped if --dry-run or --no-push)
  --version         Print version and exit
  --help            Show this help

Note: Options that take a value require a space (e.g., --config file.json).
      The --option=value syntax is not supported.

Config JSON (--config) may contain:
  defaults: { "dryRun": false, "noPush": false, "forcePush": true, "backupRemote": "backup" }
  targets: [ { "name": "Cursor", "email": "cursoragent@cursor.com" } ]
  repos: [ { "url": "...", "path": "..." }, ... ]

Repos file (--repos-file): one "url path" per line, or JSON [ {"url":"...","path":"..."}, ... ]

Examples:
  # Single repo, local only (no push)
  coauthor-trailer-cleaner.sh https://github.com/u/r /path/to/r

  # Single repo, explicit push
  coauthor-trailer-cleaner.sh --push https://github.com/u/r /path/to/r

  # Remove a different co-author identity
  coauthor-trailer-cleaner.sh --target "Pair Bot <pairbot@example.com>" --no-push https://github.com/u/r /path/to/r

  # Validate without rewriting
  coauthor-trailer-cleaner.sh --validate-only https://github.com/u/r /path/to/r

  # Batch from file
  coauthor-trailer-cleaner.sh --repos-file repos.txt

  # Batch from config with defaults
  coauthor-trailer-cleaner.sh --config my-defaults.json
EOF
}

# =============================================================================
# HELPERS
# =============================================================================

# Parses a GitHub URL into its components.
# Sets globals: PARSED_USERNAME, PARSED_REPONAME, PARSED_CANONICAL_URL.
# Returns 0 on success, 1 on failure. Callers must check return code
# before using the globals (they are reset to empty on each call).
parse_github_url() {
  local url="$1"
  local url_clean="${url%.git}"
  url_clean="${url_clean%/}"
  PARSED_USERNAME=""
  PARSED_REPONAME=""
  PARSED_CANONICAL_URL=""
  # Matches:
  # https://github.com/user/repo[.git]
  # git@github.com:user/repo[.git]
  # ssh://git@github.com/user/repo[.git]
  if [[ "$url_clean" =~ ^(https://github\.com/|git@github\.com:|ssh://git@github\.com/)([^/]+)/([^/]+)$ ]]; then
    PARSED_USERNAME="${BASH_REMATCH[2]}"
    PARSED_REPONAME="${BASH_REMATCH[3]}"
    if [[ "${BASH_REMATCH[1]}" == "git@github.com:" ]]; then
      PARSED_CANONICAL_URL="git@github.com:$PARSED_USERNAME/$PARSED_REPONAME"
    else
      PARSED_CANONICAL_URL="https://github.com/$PARSED_USERNAME/$PARSED_REPONAME"
    fi
    return 0
  fi
  return 1
}

# Normalize a GitHub URL to https://github.com/user/repo for comparison.
# Outputs nothing if the URL is not a recognized GitHub URL.
normalize_github_url_for_compare() {
  local url="${1%.git}"
  url="${url%/}"
  if [[ "$url" =~ ^(https://github\.com/|git@github\.com:|ssh://git@github\.com/)([^/]+)/([^/]+)$ ]]; then
    echo "https://github.com/${BASH_REMATCH[2]}/${BASH_REMATCH[3]}"
  fi
}

# Validate targets JSON and normalize it to a compact representation.
# Uses pure Python stdlib; sets VALIDATED_TARGETS_JSON.
validate_targets_json() {
  local targets_json="$1"
  VALIDATED_TARGETS_JSON="$(python3 -c "
import json, re, sys
EMAIL_RE = re.compile(r'^[^<>\s]+@[^<>\s]+$')
try:
    data = json.loads(sys.argv[1])
except json.JSONDecodeError as exc:
    print(f'ERROR: invalid targets JSON: {exc}', file=sys.stderr)
    sys.exit(1)
if not isinstance(data, list) or not data:
    print('ERROR: targets must be a non-empty array', file=sys.stderr)
    sys.exit(1)
normalized = []
seen = set()
for idx, target in enumerate(data):
    if not isinstance(target, dict):
        print(f'ERROR: targets[{idx}] must be an object', file=sys.stderr)
        sys.exit(1)
    name = target.get('name')
    email = target.get('email')
    if not isinstance(name, str) or not name.strip():
        print(f'ERROR: targets[{idx}].name must be a non-empty string', file=sys.stderr)
        sys.exit(1)
    if not isinstance(email, str) or not EMAIL_RE.match(email):
        print(f'ERROR: targets[{idx}].email must be a simple email address', file=sys.stderr)
        sys.exit(1)
    key = (name.strip().casefold(), email.casefold())
    if key in seen:
        continue
    seen.add(key)
    normalized.append({'name': name.strip(), 'email': email})
print(json.dumps(normalized, separators=(',', ':')))
" "$targets_json")" || return 1
}

# Convert CLI target identities into JSON target objects.
# Uses TARGET_ARGS[] and sets VALIDATED_TARGETS_JSON on success.
build_targets_json_from_cli() {
  [[ ${#TARGET_ARGS[@]} -eq 0 ]] && return 1
  VALIDATED_TARGETS_JSON="$(python3 -c "
import json, re, sys
IDENTITY_RE = re.compile(r'^\s*(.+?)\s*<([^<>\s]+@[^<>\s]+)>\s*$')
targets = []
seen = set()
for idx, raw in enumerate(sys.argv[1:], start=0):
    match = IDENTITY_RE.match(raw)
    if not match:
        print(f'ERROR: --target expects \"Name <email>\" (got: {raw})', file=sys.stderr)
        sys.exit(1)
    name = match.group(1).strip()
    email = match.group(2)
    key = (name.casefold(), email.casefold())
    if key in seen:
        continue
    seen.add(key)
    targets.append({'name': name, 'email': email})
print(json.dumps(targets, separators=(',', ':')))
" "${TARGET_ARGS[@]}")" || return 1
}

# Build a human-readable target summary from TARGETS_JSON. Sets TARGET_SUMMARY.
build_target_summary() {
  TARGET_SUMMARY="$(python3 -c "
import json, sys
targets = json.loads(sys.argv[1])
print(', '.join(f\"{target['name']} <{target['email']}>\" for target in targets))
" "$TARGETS_JSON")"
}

# Build the python callback used by git-filter-repo. Sets MESSAGE_CALLBACK.
build_message_callback() {
  MESSAGE_CALLBACK="$(python3 -c "
import json, re, sys
targets = json.loads(sys.argv[1])
lines = ['import re']
for target in targets:
    pattern = rf'(?im)^Co-authored-by:\s*{re.escape(target[\"name\"])}\s*<{re.escape(target[\"email\"])}>\s*(?:\r?\n)?'
    lines.append(f'message = re.sub({pattern!r}.encode(\"utf-8\"), b\"\", message)')
lines.append(\"message = re.sub(br'(?:\\\\r?\\\\n){3,}', b'\\\\n\\\\n', message)\")
lines.append('return message')
print('\n'.join(lines))
" "$TARGETS_JSON")"
}

# Resolve final targets from CLI, config, or defaults.
resolve_targets() {
  local source_json="$DEFAULT_TARGETS_JSON"
  if [[ ${#TARGET_ARGS[@]} -gt 0 ]]; then
    build_targets_json_from_cli || return 1
    source_json="$VALIDATED_TARGETS_JSON"
  elif [[ -n "$CONFIG_TARGETS_JSON" ]]; then
    source_json="$CONFIG_TARGETS_JSON"
  fi
  validate_targets_json "$source_json" || return 1
  TARGETS_JSON="$VALIDATED_TARGETS_JSON"
  build_target_summary
  build_message_callback
}

# Checks all local refs for remaining configured co-author trailers.
check_target_trailers() {
  local repo_path="$1"
  local scan_rc=0
  [[ "$QUIET" == false ]] && echo "  (scanning all local branches and tags for remaining configured trailers)"
  # Skip scan if repo has no commits (git log would produce no output).
  if ! git -C "$repo_path" rev-parse HEAD >/dev/null 2>&1; then
    log_info "Repository has no commits; skipping trailer scan."
    return
  fi
  set +e
  git -C "$repo_path" log --all --format='%B' |
    python3 -c "
import json, re, sys
targets = json.loads(sys.argv[1])
text = sys.stdin.buffer.read().decode('utf-8', errors='ignore')
for target in targets:
    pattern = rf'(?im)^Co-authored-by:\s*{re.escape(target[\"name\"])}\s*<{re.escape(target[\"email\"])}>\s*$'
    if re.search(pattern, text):
        sys.exit(0)
sys.exit(1)
" "$TARGETS_JSON" >/dev/null 2>&1
  scan_rc=$?
  set -e

  if [[ $scan_rc -eq 0 ]]; then
    log_warn "Configured co-author trailer still found (in --all refs)."
  elif [[ $scan_rc -eq 1 ]]; then
    log_ok "No configured co-author trailers remaining (all refs checked)."
  else
    log_warn "Could not complete trailer scan (exit code: $scan_rc)."
  fi
}

# Unified JSON extraction via a single Python invocation.
# Usage: _json_extract <file> <mode: defaults|repos|root>
# Output depends on mode:
#   defaults → KEY=value lines (DRY_RUN, NO_PUSH, FORCE_PUSH)
#   targets  → name\temail lines from data.targets[]
#   repos    → url\tpath lines from data.repos[]
#   root     → url\tpath lines from data[] (root-level array)
_json_extract() {
  local json_file="$1"
  local mode="$2"
  python3 -c "
import json, sys
mode = sys.argv[2]
with open(sys.argv[1], encoding='utf-8') as f:
    data = json.load(f)
if mode == 'defaults':
    d = data.get('defaults') if isinstance(data.get('defaults'), dict) else {}
    for k, o in [('dryRun','DRY_RUN'),('noPush','NO_PUSH'),('forcePush','FORCE_PUSH')]:
        if isinstance(d.get(k), bool): print(o + '=' + ('true' if d[k] else 'false'))
    if 'backupRemote' in d and isinstance(d.get('backupRemote'), str) and d['backupRemote']:
        print('BACKUP_REMOTE=' + d['backupRemote'])
elif mode == 'repos':
    for r in (data.get('repos') or []):
        if not isinstance(r, dict): continue
        u, p = str(r.get('url') or '').replace('\t',' '), str(r.get('path') or '').replace('\t',' ')
        print(u + '\t' + p)
elif mode == 'targets':
    for t in (data.get('targets') or []):
        if not isinstance(t, dict): continue
        n = str(t.get('name') or '').replace('\t', ' ')
        e = str(t.get('email') or '').replace('\t', ' ')
        print(n + '\t' + e)
elif mode == 'root':
    for r in (data if isinstance(data, list) else []):
        if not isinstance(r, dict): continue
        u, p = str(r.get('url') or '').replace('\t',' '), str(r.get('path') or '').replace('\t',' ')
        print(u + '\t' + p)
" "$json_file" "$mode"
}

# Print and optionally execute a command. Respects DRY_RUN, VERBOSE, and QUIET.
# In quiet mode, stdout is suppressed but stderr is preserved so real errors remain visible.
run_cmd() {
  if [[ "$VERBOSE" == true ]]; then
    printf '+'
    for a in "$@"; do
      printf ' %q' "$a"
    done
    echo
  fi
  if [[ "$DRY_RUN" == false ]]; then
    if [[ "$QUIET" == true ]]; then
      "$@" >/dev/null
    else
      "$@"
    fi
  fi
}

# Push the current branch to remote. force_push is "true" or "false". Returns 0 on success, 1 on failure.
push_branch_and_tags() {
  local repo_path="$1"
  local remote="$2"
  local branch="$3"
  local force_push="$4"
  if [[ "$force_push" == true ]]; then
    run_cmd git -C "$repo_path" push -u "$remote" --force "$branch" || return 1
  else
    run_cmd git -C "$repo_path" push -u "$remote" "$branch" || return 1
  fi
}

# Restore remotes from a backup file containing: <name>\t<kind>\t<url>
restore_remotes_from_backup() {
  local repo_path="$1"
  local backup_file="$2"
  local rname rkind rurl added_names=""

  while IFS=$'\t' read -r rname rkind rurl; do
    [[ -z "$rname" || -z "$rkind" || -z "$rurl" ]] && continue
    if [[ " $added_names " != *" $rname "* ]]; then
      git -C "$repo_path" remote add "$rname" "$rurl" 2>/dev/null || true
      added_names="$added_names $rname"
      if [[ "$rkind" == "push" ]]; then
        git -C "$repo_path" remote set-url --push "$rname" "$rurl" 2>/dev/null || true
      fi
      continue
    fi
    if [[ "$rkind" == "fetch" ]]; then
      git -C "$repo_path" remote set-url --add "$rname" "$rurl" 2>/dev/null || true
    else
      git -C "$repo_path" remote set-url --push --add "$rname" "$rurl" 2>/dev/null || true
    fi
  done <"$backup_file"
}

# Resolve push remote from backed-up remotes by exact canonical GitHub URL match.
# Prints the selected remote name on stdout; returns 1 if none or multiple match.
resolve_target_remote() {
  local backup_file="$1"
  local canonical_url="$2"
  local canonical_norm
  local rname rurl
  local -a matches=()
  canonical_norm=$(normalize_github_url_for_compare "$canonical_url")
  [[ -n "$canonical_norm" ]] || return 1

  while IFS=$'\t' read -r rname rkind rurl; do
    [[ -z "$rname" || -z "$rurl" ]] && continue
    [[ "$rkind" == "fetch" || "$rkind" == "push" ]] || continue
    if [[ -n "$canonical_norm" && "$(normalize_github_url_for_compare "$rurl")" == "$canonical_norm" ]]; then
      matches+=("$rname")
    fi
  done <"$backup_file"

  if [[ "${#matches[@]}" -eq 1 ]]; then
    echo "${matches[0]}"
    return 0
  fi
  return 1
}

rollback_local_rewrite() {
  local repo_path="$1"
  local backup_branch="$2"
  [[ -n "$backup_branch" ]] || return 1
  run_cmd git -C "$repo_path" reset --hard "$backup_branch" || return 1
}
