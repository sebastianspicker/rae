# shellcheck shell=bash
# shellcheck disable=SC2034 # Globals are consumed by sibling sourced modules.
# Validates cleaner configuration before its repository and rewrite settings are trusted.

validate_config_json() {
  "$PYTHON_BIN" - "$1" <<'PY'
import json
import re
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    data = json.load(handle)
if not isinstance(data, dict):
    raise SystemExit("ERROR: Config must be a JSON object")
unknown = set(data) - {"defaults", "targets", "repos"}
if unknown:
    raise SystemExit(f"ERROR: unsupported config key: {sorted(unknown)[0]}")
defaults = data.get("defaults", {})
if not isinstance(defaults, dict):
    raise SystemExit("ERROR: defaults must be an object")
unknown_defaults = set(defaults) - {"dryRun", "noPush", "backupRemote"}
if unknown_defaults:
    raise SystemExit(f"ERROR: unsupported defaults key: {sorted(unknown_defaults)[0]}")
for key in ("dryRun", "noPush"):
    if key in defaults and not isinstance(defaults[key], bool):
        raise SystemExit(f"ERROR: defaults.{key} must be a boolean")
backup_remote = defaults.get("backupRemote")
if backup_remote is not None and (
    not isinstance(backup_remote, str)
    or not re.fullmatch(r"[a-zA-Z0-9_.-]+", backup_remote)
):
    raise SystemExit("ERROR: defaults.backupRemote must be a valid remote name")
targets = data.get("targets")
if targets is not None:
    if not isinstance(targets, list) or not targets:
        raise SystemExit("ERROR: targets must be a non-empty array")
    for index, target in enumerate(targets):
        if not isinstance(target, dict) or set(target) != {"name", "email"}:
            raise SystemExit(f"ERROR: targets[{index}] must contain only name and email")
        if not isinstance(target["name"], str) or not target["name"].strip():
            raise SystemExit(f"ERROR: targets[{index}].name must be a non-empty string")
        if not isinstance(target["email"], str) or not re.fullmatch(r"[^<>\s]+@[^<>\s]+", target["email"]):
            raise SystemExit(f"ERROR: targets[{index}].email must be a simple email address")
repos = data.get("repos")
if repos is not None:
    if not isinstance(repos, list):
        raise SystemExit("ERROR: repos must be an array")
    for index, repo in enumerate(repos):
        if not isinstance(repo, dict) or set(repo) != {"url", "path"}:
            raise SystemExit(f"ERROR: repos[{index}] must contain only url and path")
        if not isinstance(repo["url"], str) or not repo["url"]:
            raise SystemExit(f"ERROR: repos[{index}].url must be a non-empty string")
        if not isinstance(repo["path"], str) or not repo["path"]:
            raise SystemExit(f"ERROR: repos[{index}].path must be a non-empty string")
PY
}

apply_config_defaults() {
  local config_file="$1"
  local line key value
  [[ -z "$config_file" || ! -f "$config_file" ]] && return 0
  while IFS= read -r line; do
    key="${line%%=*}"
    value="${line#*=}"
    case "$key" in
    DRY_RUN) DRY_RUN="$value" ;;
    NO_PUSH) NO_PUSH="$value" ;;
    BACKUP_REMOTE) BACKUP_REMOTE="$value" ;;
    esac
  done < <(json_extract "$config_file" defaults)
}

load_repos_from_json_file() {
  local json_file="$1"
  local mode="${2:-repos}"
  local line
  while IFS= read -r line; do
    [[ "$line" == *$'\t'* ]] || continue
    REPO_URLS+=("${line%%$'\t'*}")
    REPO_PATHS+=("${line#*$'\t'}")
  done < <(json_extract "$json_file" "$mode")
}

load_targets_from_config() {
  local config_file="$1"
  local targets_json
  [[ -z "$config_file" || ! -f "$config_file" ]] && return 0
  targets_json="$("$PYTHON_BIN" - "$config_file" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    targets = json.load(handle).get("targets")
if targets:
    print(json.dumps(targets, separators=(",", ":")))
PY
)"
  if [[ -n "$targets_json" ]]; then
    validate_targets_json "$targets_json" || return 1
    CONFIG_TARGETS_JSON="$VALIDATED_TARGETS_JSON"
  fi
}

load_repos_from_file() {
  local repos_file="$1"
  local first_char line url path
  first_char="$("$PYTHON_BIN" - "$repos_file" <<'PY'
import sys
with open(sys.argv[1], encoding="utf-8") as handle:
    for line in handle:
        stripped = line.lstrip()
        if stripped:
            print(stripped[0])
            break
PY
)"
  if "$PYTHON_BIN" - "$repos_file" >/dev/null 2>&1 <<'PY'
import json
import sys
with open(sys.argv[1], encoding="utf-8") as handle:
    raise SystemExit(0 if isinstance(json.load(handle), list) else 1)
PY
  then
    load_repos_from_json_file "$repos_file" root
  elif [[ "$first_char" == "{" || "$first_char" == "[" ]]; then
    log_error "Repos file appears to be JSON but is not a valid repository array: $repos_file"
    return 1
  else
    while IFS= read -r line; do
      line="${line#"${line%%[![:space:]]*}"}"
      line="${line%"${line##*[![:space:]]}"}"
      [[ -z "$line" || "$line" == \#* ]] && continue
      url="${line%% *}"
      path="${line#* }"
      path="${path#"${path%%[![:space:]]*}"}"
      path="${path%"${path##*[![:space:]]}"}"
      if [[ -z "$path" || "$path" == "$url" ]]; then
        log_warn "Repos file line must be 'url path'; path missing: $line"
        continue
      fi
      REPO_URLS+=("$url")
      REPO_PATHS+=("$path")
    done <"$repos_file"
  fi
}
