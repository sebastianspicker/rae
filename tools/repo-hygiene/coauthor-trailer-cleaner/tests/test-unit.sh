#!/usr/bin/env bash
# Unit tests for coauthor-trailer-cleaner.sh
# shellcheck disable=SC2034,SC2317,SC2329 # Directly sourced module globals and test doubles.

# ── URL Parsing Tests ───────────────────────────────────────────

test_parse_github_url_https() {
  (
    PARSED_USERNAME="" PARSED_REPONAME="" PARSED_CANONICAL_URL=""
    parse_github_url "https://github.com/user/repo"
    assert_equals "user" "$PARSED_USERNAME" "username from HTTPS URL"
    assert_equals "repo" "$PARSED_REPONAME" "reponame from HTTPS URL"
    assert_equals "https://github.com/user/repo" "$PARSED_CANONICAL_URL" "canonical URL"
  )
}

test_parse_github_url_ssh() {
  (
    PARSED_USERNAME="" PARSED_REPONAME="" PARSED_CANONICAL_URL=""
    parse_github_url "git@github.com:myorg/myrepo.git"
    assert_equals "myorg" "$PARSED_USERNAME" "username from SSH URL"
    assert_equals "myrepo" "$PARSED_REPONAME" "reponame from SSH URL"
    assert_equals "git@github.com:myorg/myrepo" "$PARSED_CANONICAL_URL" "canonical SSH URL"
  )
}

test_parse_github_url_ssh_protocol() {
  (
    PARSED_USERNAME="" PARSED_REPONAME="" PARSED_CANONICAL_URL=""
    parse_github_url "ssh://git@github.com/user/repo"
    assert_equals "user" "$PARSED_USERNAME" "username from ssh:// URL"
    assert_equals "repo" "$PARSED_REPONAME" "reponame from ssh:// URL"
  )
}

test_parse_github_url_with_dotgit() {
  (
    PARSED_USERNAME="" PARSED_REPONAME="" PARSED_CANONICAL_URL=""
    parse_github_url "https://github.com/user/repo.git"
    assert_equals "user" "$PARSED_USERNAME" "username strips .git"
    assert_equals "repo" "$PARSED_REPONAME" "reponame strips .git"
  )
}

test_parse_github_url_trailing_slash() {
  (
    PARSED_USERNAME="" PARSED_REPONAME="" PARSED_CANONICAL_URL=""
    parse_github_url "https://github.com/user/repo/"
    assert_equals "user" "$PARSED_USERNAME" "username with trailing slash"
    assert_equals "repo" "$PARSED_REPONAME" "reponame with trailing slash"
  )
}

test_parse_github_url_invalid() {
  (
    PARSED_USERNAME="" PARSED_REPONAME="" PARSED_CANONICAL_URL=""
    if parse_github_url "https://gitlab.com/user/repo" 2>/dev/null; then
      echo "    Expected parse_github_url to fail for non-GitHub URL"
      return 1
    fi
    return 0
  )
}

# ── CLI Tests ───────────────────────────────────────────────────

test_cli_help_exits_zero() {
  assert_exit_code 0 bash "$SCRIPT_PATH" --help
}

test_cli_help_matches_committed_snapshot() {
  local expected actual
  expected="$(cat "$(dirname "$SCRIPT_PATH")/docs/screenshots/help.txt")"
  actual="$(bash "$SCRIPT_PATH" --help)"
  assert_equals "$expected" "$actual" "help snapshot should match the live CLI"
}

test_cli_version_outputs_version() {
  local output
  output=$(bash "$SCRIPT_PATH" --version 2>&1)
  assert_contains "$output" "coauthor-trailer-cleaner" "version output contains program name"
  if ! echo "$output" | grep -qE '[0-9]+\.[0-9]+\.[0-9]+'; then
    echo "    Version output doesn't match N.N.N pattern: $output"
    return 1
  fi
}

test_cli_unknown_option_fails() {
  assert_exit_code 1 bash "$SCRIPT_PATH" --nonexistent-option
}

test_cli_removed_force_push_options_fail() {
  assert_exit_code 1 bash "$SCRIPT_PATH" --force-push
  assert_exit_code 1 bash "$SCRIPT_PATH" --no-force-push
}

test_cli_no_args_fails() {
  assert_exit_code 1 bash "$SCRIPT_PATH"
}

test_cli_invalid_backup_remote_name() {
  local rc=0
  bash "$SCRIPT_PATH" --backup-remote "bad remote!" --validate-only \
    "https://github.com/test/repo" "/tmp/repo" >/dev/null 2>&1 || rc=$?
  if [[ $rc -eq 0 ]]; then
    echo "    Expected non-zero exit for invalid backup-remote name"
    return 1
  fi
}

test_cli_invalid_target_format() {
  local rc=0
  bash "$SCRIPT_PATH" --target "not-an-identity" --validate-only \
    "https://github.com/test/repo" "/tmp/repo" >/dev/null 2>&1 || rc=$?
  if [[ $rc -eq 0 ]]; then
    echo "    Expected non-zero exit for invalid --target format"
    return 1
  fi
}

test_resolve_target_remote_requires_exact_match() {
  local dir
  dir=$(create_test_dir)
  cat >"$dir/remotes.tsv" <<'EOF'
origin	fetch	https://github.com/test/repo
backup	fetch	https://github.com/test/repo-backup
EOF
  (
    local resolved
    resolved="$(resolve_target_remote "$dir/remotes.tsv" "https://github.com/test/repo")" || return 1
    assert_equals "origin" "$resolved" "resolve_target_remote should return the exact canonical match"
  )
}

test_resolve_target_remote_rejects_no_match() {
  local dir
  dir=$(create_test_dir)
  cat >"$dir/remotes.tsv" <<'EOF'
origin	fetch	https://github.com/test/other-repo
EOF
  (
    if resolve_target_remote "$dir/remotes.tsv" "https://github.com/test/repo" >/dev/null 2>&1; then
      echo "    Expected resolve_target_remote to fail without an exact match"
      return 1
    fi
  )
}

test_resolve_target_remote_rejects_ambiguous_matches() {
  local dir
  dir=$(create_test_dir)
  cat >"$dir/remotes.tsv" <<'EOF'
origin	fetch	https://github.com/test/repo
mirror	fetch	git@github.com:test/repo.git
EOF
  (
    if resolve_target_remote "$dir/remotes.tsv" "https://github.com/test/repo" >/dev/null 2>&1; then
      echo "    Expected resolve_target_remote to fail for ambiguous exact matches"
      return 1
    fi
  )
}

test_restore_remotes_preserves_push_urls() {
  local dir repo
  dir=$(create_test_dir)
  repo="$dir/repo"
  mkdir -p "$repo"
  git -C "$repo" init -q
  cat >"$dir/remotes.tsv" <<'EOF'
origin	fetch	https://github.com/test/repo
origin	push	git@github.com:test/repo.git
EOF
  (
    restore_remotes_from_backup "$repo" "$dir/remotes.tsv"
    local remotes
    remotes="$(git -C "$repo" remote -v)"
    assert_contains "$remotes" $'origin\thttps://github.com/test/repo (fetch)' "fetch URL should be restored"
    assert_contains "$remotes" $'origin\tgit@github.com:test/repo.git (push)' "push URL should be restored"
  )
}

test_push_rewritten_branch_uses_exact_oid_lease() {
  (
    CAPTURED_COMMANDS=""
    local remotes_file
    remotes_file="$(mktemp)"
    printf 'origin\tfetch\thttps://github.com/test/repo\n' >"$remotes_file"
    BACKUP_REMOTES_TMP="$remotes_file"
    CANONICAL_URL="https://github.com/test/repo"
    UPSTREAM_REMOTE="origin"
    UPSTREAM_REMOTE_REF="refs/heads/main"
    EXPECTED_UPSTREAM_OID="0123456789012345678901234567890123456789"
    REWRITTEN_HEAD_OID="abcdefabcdefabcdefabcdefabcdefabcdefabcd"
    run_cmd() {
      CAPTURED_COMMANDS+="$*\n"
      return 0
    }
    push_rewritten_branch "/tmp/repo" || return 1
    rm -f "$remotes_file"
    assert_contains "$CAPTURED_COMMANDS" "--force-with-lease=refs/heads/main:0123456789012345678901234567890123456789" "push must bind the exact observed upstream OID"
    assert_contains "$CAPTURED_COMMANDS" \
      "abcdefabcdefabcdefabcdefabcdefabcdefabcd:refs/heads/main" \
      "push must use the commit-map-derived rewritten OID"
    assert_not_contains "$CAPTURED_COMMANDS" " --force " "plain force push must never be used"
  )
}

test_cleanup_retains_backups_when_verification_fails() {
  (
    DRY_RUN=false
    TARGET_REMOTE="origin"
    BACKUP_BRANCH="backup/coauthor-trailer-cleaner-test"
    BACKUP_BRANCH_PREFIX="backup/coauthor-trailer-cleaner-"
    VERBOSE=false
    CAPTURED_COMMANDS=""
    REWRITTEN_HEAD_OID="rewritten-test-oid"
    transaction_state_matches() { return 0; }
    check_target_trailers() { return 1; }
    log_error() { :; }
    run_cmd() { CAPTURED_COMMANDS+="$*\n"; }

    if verify_and_cleanup "/tmp/coauthor-trailer-cleaner-test-repo"; then
      echo "    Expected cleanup to fail when trailer verification fails"
      return 1
    fi
    assert_not_contains "$CAPTURED_COMMANDS" "branch -D" "local recovery branch must be retained after verification failure"
    assert_not_contains "$CAPTURED_COMMANDS" "push origin --delete" "remote recovery branches must never be deleted"
  )
}

test_cleanup_deletes_only_current_run_transaction_refs() {
  local repo current_recovery old_recovery transaction_ref original_oid
  repo=$(setup_clean_test_repo)
  original_oid="$(git -C "$repo" rev-parse HEAD)"
  current_recovery="backup/coauthor-trailer-cleaner-current"
  old_recovery="backup/coauthor-trailer-cleaner-old"
  transaction_ref="refs/coauthor-trailer-cleaner/transactions/current"
  git -C "$repo" branch "$current_recovery" "$original_oid"
  git -C "$repo" branch "$old_recovery" "$original_oid"
  git -C "$repo" update-ref "$transaction_ref" "$original_oid"
  (
    DRY_RUN=false
    TARGET_REMOTE=""
    CURRENT_BRANCH="$(git -C "$repo" symbolic-ref --quiet --short HEAD)"
    BACKUP_BRANCH="$current_recovery"
    TRANSACTION_REF="$transaction_ref"
    ORIGINAL_HEAD_OID="$original_oid"
    REWRITTEN_HEAD_OID="$original_oid"
    TARGETS_JSON='[{"name":"Cursor","email":"cursoragent@cursor.com"}]'
    QUIET=true
    VERBOSE=false
    verify_and_cleanup "$repo"
  )
  if git -C "$repo" show-ref --verify --quiet "refs/heads/$current_recovery"; then
    echo "    Expected exact current-run recovery branch to be deleted"
    return 1
  fi
  git -C "$repo" show-ref --verify --quiet "refs/heads/$old_recovery" || {
    echo "    Older recovery branch must be retained"
    return 1
  }
  if git -C "$repo" show-ref --verify --quiet "$transaction_ref"; then
    echo "    Expected exact current-run transaction ref to be deleted"
    return 1
  fi
}

test_no_push_propagates_cleanup_verification_failure() {
  (
    NO_PUSH=true
    DRY_RUN=false
    VALIDATE_ONLY=false
    QUIET=false
    validate_repo_input() { return 0; }
    do_rewrite_and_restore_remotes() { return 0; }
    verify_and_cleanup() { return 1; }
    log_info() { :; }

    if process_one_repo "https://github.com/example/repo" "/tmp/example-repo"; then
      echo "    Expected no-push rewrite to fail when cleanup verification fails"
      return 1
    fi
  )
}

test_trailer_check_fails_when_forbidden_trailer_remains() {
  local repo
  repo=$(setup_test_repo)
  (
    QUIET=true
    TARGETS_JSON='[{"name":"Cursor","email":"cursoragent@cursor.com"}]'
    log_warn() { :; }
    log_ok() { :; }
    if check_target_trailers "$repo"; then
      echo "    Expected trailer check to fail when a configured trailer remains"
      return 1
    fi
  )
}

test_trailer_check_fails_when_current_and_backup_share_forbidden_commit() {
  local repo
  repo=$(setup_test_repo)
  (
    QUIET=true
    TARGETS_JSON='[{"name":"Cursor","email":"cursoragent@cursor.com"}]'
    BACKUP_BRANCH_PREFIX="backup/coauthor-trailer-cleaner-"
    BACKUP_BRANCH="${BACKUP_BRANCH_PREFIX}shared"
    git -C "$repo" branch "$BACKUP_BRANCH" HEAD
    log_warn() { :; }
    log_ok() { :; }
    if check_target_trailers "$repo"; then
      echo "    Expected trailer check to scan commits shared with a recovery ref"
      return 1
    fi
  )
}

test_trailer_check_excludes_recovery_only_commits() {
  local repo
  repo=$(setup_clean_test_repo)
  (
    QUIET=true
    TARGETS_JSON='[{"name":"Cursor","email":"cursoragent@cursor.com"}]'
    BACKUP_BRANCH_PREFIX="backup/coauthor-trailer-cleaner-"
    BACKUP_BRANCH="${BACKUP_BRANCH_PREFIX}recovery-only"
    printf 'recovery\n' >"$repo/recovery.txt"
    git -C "$repo" add recovery.txt
    git -C "$repo" commit -q -m $'Recovery commit\n\nCo-authored-by: Cursor <cursoragent@cursor.com>'
    git -C "$repo" branch "$BACKUP_BRANCH" HEAD
    git -C "$repo" reset --hard -q HEAD^
    log_warn() { :; }
    log_ok() { :; }
    check_target_trailers "$repo"
  )
}

test_trailer_check_fails_when_scan_errors() {
  local repo
  repo=$(setup_clean_test_repo)
  (
    QUIET=true
    TARGETS_JSON='[{"name":"Cursor","email":"cursoragent@cursor.com"}]'
    log_warn() { :; }
    log_ok() { :; }
    git() {
      if [[ "$*" == *" log "* ]]; then
        return 42
      fi
      command git "$@"
    }
    if check_target_trailers "$repo"; then
      echo "    Expected trailer check to fail when git log cannot scan refs"
      return 1
    fi
  )
}

# ── JSON Config Validation Tests ────────────────────────────────

test_valid_config_json() {
  local dir
  dir=$(create_test_dir)
  cat >"$dir/config.json" <<'CONF'
{
  "defaults": { "dryRun": true, "noPush": false },
  "targets": [{ "name": "Cursor", "email": "cursoragent@cursor.com" }],
  "repos": [{"url": "https://github.com/u/r", "path": "/tmp/r"}]
}
CONF
  local output rc=0
  output=$(bash "$SCRIPT_PATH" --config "$dir/config.json" --validate-only 2>&1) || rc=$?
  assert_not_contains "$output" "Config file validation failed" "valid config should pass validation"
}

test_invalid_json_syntax() {
  local dir
  dir=$(create_test_dir)
  echo "{ not valid json }" >"$dir/bad.json"
  local rc=0
  bash "$SCRIPT_PATH" --config "$dir/bad.json" --validate-only >/dev/null 2>&1 || rc=$?
  if [[ $rc -eq 0 ]]; then
    echo "    Expected non-zero exit for invalid JSON"
    return 1
  fi
}

test_config_missing_url() {
  local dir
  dir=$(create_test_dir)
  cat >"$dir/config.json" <<'CONF'
{
  "repos": [{"path": "/tmp/r"}]
}
CONF
  local rc=0
  bash "$SCRIPT_PATH" --config "$dir/config.json" --validate-only >/dev/null 2>&1 || rc=$?
  if [[ $rc -eq 0 ]]; then
    echo "    Expected non-zero exit for missing url field"
    return 1
  fi
}

test_config_missing_path() {
  local dir
  dir=$(create_test_dir)
  cat >"$dir/config.json" <<'CONF'
{
  "repos": [{"url": "https://github.com/u/r"}]
}
CONF
  local rc=0
  bash "$SCRIPT_PATH" --config "$dir/config.json" --validate-only >/dev/null 2>&1 || rc=$?
  if [[ $rc -eq 0 ]]; then
    echo "    Expected non-zero exit for missing path field"
    return 1
  fi
}

test_config_invalid_backup_remote() {
  local dir
  dir=$(create_test_dir)
  cat >"$dir/config.json" <<'CONF'
{
  "defaults": { "backupRemote": "bad remote!" },
  "repos": [{"url": "https://github.com/u/r", "path": "/tmp/r"}]
}
CONF
  local rc=0
  bash "$SCRIPT_PATH" --config "$dir/config.json" --validate-only >/dev/null 2>&1 || rc=$?
  if [[ $rc -eq 0 ]]; then
    echo "    Expected non-zero exit for invalid backupRemote in config"
    return 1
  fi
}

test_config_rejects_removed_force_push_default() {
  local dir
  dir=$(create_test_dir)
  cat >"$dir/config.json" <<'CONF'
{
  "defaults": { "forcePush": true },
  "repos": [{"url": "https://github.com/u/r", "path": "/tmp/r"}]
}
CONF
  assert_exit_code 1 bash "$SCRIPT_PATH" --config "$dir/config.json" --validate-only
}

test_config_invalid_target_email() {
  local dir
  dir=$(create_test_dir)
  cat >"$dir/config.json" <<'CONF'
{
  "targets": [{ "name": "Pair Bot", "email": "not-an-email" }],
  "repos": [{"url": "https://github.com/u/r", "path": "/tmp/r"}]
}
CONF
  local rc=0
  bash "$SCRIPT_PATH" --config "$dir/config.json" --validate-only >/dev/null 2>&1 || rc=$?
  if [[ $rc -eq 0 ]]; then
    echo "    Expected non-zero exit for invalid target email"
    return 1
  fi
}

# ── Target Resolution and Callback Tests ────────────────────────

test_callback_removes_default_target() {
  local result
  result=$(
    TARGETS_JSON='[{"name":"Cursor","email":"cursoragent@cursor.com"}]' \
      "$PYTHON_BIN" -c "
import json, re, sys
targets = json.loads(sys.argv[1])
message = sys.stdin.buffer.read()
for target in targets:
    pattern = rf'(?im)^Co-authored-by:\s*{re.escape(target[\"name\"])}\s*<{re.escape(target[\"email\"])}>\s*(?:\r?\n)?'
    message = re.sub(pattern.encode('utf-8'), b'', message)
message = re.sub(br'(?:\r?\n){3,}', b'\n\n', message)
sys.stdout.buffer.write(message)
" '[{"name":"Cursor","email":"cursoragent@cursor.com"}]' <<'EOF'
Some message

Co-authored-by: Cursor <cursoragent@cursor.com>
EOF
  )
  assert_not_contains "$result" "cursoragent" "default target trailer should be removed"
  assert_contains "$result" "Some message" "original message should be preserved"
}

test_callback_preserves_other_trailers() {
  local result
  result=$(
    "$PYTHON_BIN" -c "
import json, re, sys
targets = json.loads(sys.argv[1])
message = sys.stdin.buffer.read()
for target in targets:
    pattern = rf'(?im)^Co-authored-by:\s*{re.escape(target[\"name\"])}\s*<{re.escape(target[\"email\"])}>\s*(?:\r?\n)?'
    message = re.sub(pattern.encode('utf-8'), b'', message)
message = re.sub(br'(?:\r?\n){3,}', b'\n\n', message)
sys.stdout.buffer.write(message)
" '[{"name":"Cursor","email":"cursoragent@cursor.com"}]' <<'EOF'
Some message

Co-authored-by: Human <human@example.com>
Co-authored-by: Cursor <cursoragent@cursor.com>
EOF
  )
  assert_contains "$result" "Human <human@example.com>" "non-target trailers should be preserved"
  assert_not_contains "$result" "cursoragent" "target trailer should be removed"
}

test_callback_removes_custom_target() {
  local result
  result=$(
    "$PYTHON_BIN" -c "
import json, re, sys
targets = json.loads(sys.argv[1])
message = sys.stdin.buffer.read()
for target in targets:
    pattern = rf'(?im)^Co-authored-by:\s*{re.escape(target[\"name\"])}\s*<{re.escape(target[\"email\"])}>\s*(?:\r?\n)?'
    message = re.sub(pattern.encode('utf-8'), b'', message)
message = re.sub(br'(?:\r?\n){3,}', b'\n\n', message)
sys.stdout.buffer.write(message)
" '[{"name":"Pair Bot","email":"pairbot@example.com"}]' <<'EOF'
Message

Co-authored-by: Pair Bot <pairbot@example.com>
EOF
  )
  assert_not_contains "$result" "pairbot@example.com" "custom target trailer should be removed"
}

test_callback_collapses_blank_lines() {
  local result
  result=$(
    "$PYTHON_BIN" -c "
import re, sys
message = sys.stdin.buffer.read()
message = re.sub(br'(?:\r?\n){3,}', b'\n\n', message)
sys.stdout.buffer.write(message)
" <<'EOF'
Message



After gap
EOF
  )
  local consecutive
  consecutive=$(echo "$result" | "$PYTHON_BIN" -c "
import re, sys
text = sys.stdin.read()
print(1 if re.search(r'\n{3,}', text) else 0)
")
  if [[ "$consecutive" != "0" ]]; then
    echo "    Expected blank lines to be collapsed to max 2 newlines"
    return 1
  fi
}
