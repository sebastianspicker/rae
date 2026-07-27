# shellcheck shell=bash
# shellcheck disable=SC2034 # Globals are consumed by sibling sourced modules.
# Provides shared validation, logging, and target-resolution helpers for the cleaner workflow.

PROGRAM_NAME="coauthor-trailer-cleaner"
VERSION="3.0.0"
BACKUP_BRANCH_PREFIX="backup/coauthor-trailer-cleaner-"
TRANSACTION_REF_PREFIX="refs/coauthor-trailer-cleaner/transactions/"
DEFAULT_TARGETS_JSON='[{"name":"Cursor","email":"cursoragent@cursor.com"}]'
TARGETS_JSON="$DEFAULT_TARGETS_JSON"
TARGET_SUMMARY="Cursor <cursoragent@cursor.com>"
MESSAGE_CALLBACK=""
TEMP_FILES=()

use_color=false
if [[ -t 1 && -z "${NO_COLOR:-}" ]]; then
  use_color=true
fi

cleanup_temp_files() {
  local file
  for file in "${TEMP_FILES[@]}"; do
    [[ -f "$file" ]] && rm -f "$file"
  done
}

create_temp_file() {
  CREATED_TEMP_FILE="$(mktemp)"
  TEMP_FILES+=("$CREATED_TEMP_FILE")
}

log_ok() {
  if [[ "$use_color" == true ]]; then
    printf '\033[32m[ok]\033[0m %s\n' "$*"
  else
    printf '[ok] %s\n' "$*"
  fi
}

log_warn() {
  if [[ "$use_color" == true ]]; then
    printf '\033[33m[warn]\033[0m %s\n' "$*" >&2
  else
    printf '[warn] %s\n' "$*" >&2
  fi
}

log_error() {
  if [[ "$use_color" == true ]]; then
    printf '\033[31m[error]\033[0m %s\n' "$*" >&2
  else
    printf '[error] %s\n' "$*" >&2
  fi
}

log_info() {
  [[ "$QUIET" == false ]] && printf '[info] %s\n' "$*"
}

require_command() {
  local command_name
  for command_name in "$@"; do
    if ! command -v "$command_name" >/dev/null 2>&1; then
      log_error "Required command not found: $command_name"
      return 1
    fi
  done
}

usage() {
  cat <<'EOF'
Usage:
  coauthor-trailer-cleaner.sh [OPTIONS] [<github_repo_url> <absolute_local_repo_path> ...]
  coauthor-trailer-cleaner.sh [OPTIONS] --repos-file <file>
  coauthor-trailer-cleaner.sh [OPTIONS] --config <config.json>

Options:
  --dry-run         Print commands, do not run them
  --push            Rewrite history and push with an exact upstream OID lease
  --no-push         Rewrite history locally only (default)
  --validate-only   Run all checks but do not rewrite history or push
  --quiet           Minimal output: one line per repo
  --verbose         Show every git command (default)
  --target <id>     Remove this identity; repeatable, format: "Name <email>"
  --config <file>   Load defaults and optionally repos from JSON
  --repos-file <f>  Process repos from JSON or "url path" lines
  --backup-remote <name>  Retain an exact recovery branch on this remote before rewriting
  --version         Print version and exit
  --help            Show this help

Config defaults may contain dryRun, noPush, and backupRemote. Remote rewrites
always use --force-with-lease=<upstream-ref>:<pre-rewrite-upstream-OID>.
EOF
}

parse_github_url() {
  local url_clean="${1%.git}"
  url_clean="${url_clean%/}"
  PARSED_USERNAME=""
  PARSED_REPONAME=""
  PARSED_CANONICAL_URL=""
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

normalize_github_url_for_compare() {
  local url="${1%.git}"
  url="${url%/}"
  if [[ "$url" =~ ^(https://github\.com/|git@github\.com:|ssh://git@github\.com/)([^/]+)/([^/]+)$ ]]; then
    printf 'https://github.com/%s/%s\n' "${BASH_REMATCH[2]}" "${BASH_REMATCH[3]}"
  fi
}

validate_targets_json() {
  VALIDATED_TARGETS_JSON="$("$PYTHON_BIN" - "$1" <<'PY'
import json
import re
import sys

email_re = re.compile(r"^[^<>\s]+@[^<>\s]+$")
try:
    data = json.loads(sys.argv[1])
except json.JSONDecodeError as exc:
    raise SystemExit(f"ERROR: invalid targets JSON: {exc}")
if not isinstance(data, list) or not data:
    raise SystemExit("ERROR: targets must be a non-empty array")
normalized = []
seen = set()
for index, target in enumerate(data):
    if not isinstance(target, dict):
        raise SystemExit(f"ERROR: targets[{index}] must be an object")
    name = target.get("name")
    email = target.get("email")
    if not isinstance(name, str) or not name.strip():
        raise SystemExit(f"ERROR: targets[{index}].name must be a non-empty string")
    if not isinstance(email, str) or not email_re.match(email):
        raise SystemExit(f"ERROR: targets[{index}].email must be a simple email address")
    key = (name.strip().casefold(), email.casefold())
    if key not in seen:
        normalized.append({"name": name.strip(), "email": email})
        seen.add(key)
print(json.dumps(normalized, separators=(",", ":")))
PY
)" || return 1
}

build_targets_json_from_cli() {
  [[ ${#TARGET_ARGS[@]} -gt 0 ]] || return 1
  VALIDATED_TARGETS_JSON="$("$PYTHON_BIN" - "${TARGET_ARGS[@]}" <<'PY'
import json
import re
import sys

identity_re = re.compile(r"^\s*(.+?)\s*<([^<>\s]+@[^<>\s]+)>\s*$")
targets = []
seen = set()
for raw in sys.argv[1:]:
    match = identity_re.match(raw)
    if not match:
        raise SystemExit(f'ERROR: --target expects "Name <email>" (got: {raw})')
    name, email = match.group(1).strip(), match.group(2)
    key = (name.casefold(), email.casefold())
    if key not in seen:
        targets.append({"name": name, "email": email})
        seen.add(key)
print(json.dumps(targets, separators=(",", ":")))
PY
)" || return 1
}

build_target_summary() {
  TARGET_SUMMARY="$("$PYTHON_BIN" - "$TARGETS_JSON" <<'PY'
import json
import sys

print(", ".join(f"{target['name']} <{target['email']}>" for target in json.loads(sys.argv[1])))
PY
)"
}

build_message_callback() {
  MESSAGE_CALLBACK="$("$PYTHON_BIN" - "$TARGETS_JSON" <<'PY'
import json
import re
import sys

lines = ["import re"]
for target in json.loads(sys.argv[1]):
    pattern = rf'(?im)^Co-authored-by:\s*{re.escape(target["name"])}\s*<{re.escape(target["email"])}>\s*(?:\r?\n)?'
    lines.append(f'message = re.sub({pattern!r}.encode("utf-8"), b"", message)')
lines.append("message = re.sub(br'(?:\\r?\\n){3,}', b'\\n\\n', message)")
lines.append("return message")
print("\n".join(lines))
PY
)"
}

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

json_extract() {
  "$PYTHON_BIN" - "$1" "$2" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    data = json.load(handle)
mode = sys.argv[2]
if mode == "defaults":
    defaults = data.get("defaults") if isinstance(data.get("defaults"), dict) else {}
    for source, output in (("dryRun", "DRY_RUN"), ("noPush", "NO_PUSH")):
        if isinstance(defaults.get(source), bool):
            print(f"{output}={'true' if defaults[source] else 'false'}")
    if isinstance(defaults.get("backupRemote"), str) and defaults["backupRemote"]:
        print(f"BACKUP_REMOTE={defaults['backupRemote']}")
elif mode == "targets":
    for target in data.get("targets") or []:
        if isinstance(target, dict):
            print(f"{str(target.get('name') or '').replace(chr(9), ' ')}\t{str(target.get('email') or '').replace(chr(9), ' ')}")
elif mode in {"repos", "root"}:
    repos = data.get("repos") or [] if mode == "repos" else data if isinstance(data, list) else []
    for repo in repos:
        if isinstance(repo, dict):
            print(f"{str(repo.get('url') or '').replace(chr(9), ' ')}\t{str(repo.get('path') or '').replace(chr(9), ' ')}")
PY
}

run_cmd() {
  local argument
  if [[ "$VERBOSE" == true ]]; then
    printf '+'
    for argument in "$@"; do
      printf ' %q' "$argument"
    done
    printf '\n'
  fi
  if [[ "$DRY_RUN" == false ]]; then
    if [[ "$QUIET" == true ]]; then
      "$@" >/dev/null
    else
      "$@"
    fi
  fi
}
