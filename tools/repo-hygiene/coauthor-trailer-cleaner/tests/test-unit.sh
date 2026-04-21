#!/usr/bin/env bash
# Unit tests for coauthor-trailer-cleaner.sh

# ── URL Parsing Tests ───────────────────────────────────────────

test_parse_github_url_https() {
  (
    eval "$(sed -n '/^parse_github_url()/,/^}/p' "$LIB1_PATH")"
    PARSED_USERNAME="" PARSED_REPONAME="" PARSED_CANONICAL_URL=""
    parse_github_url "https://github.com/user/repo"
    assert_equals "user" "$PARSED_USERNAME" "username from HTTPS URL"
    assert_equals "repo" "$PARSED_REPONAME" "reponame from HTTPS URL"
    assert_equals "https://github.com/user/repo" "$PARSED_CANONICAL_URL" "canonical URL"
  )
}

test_parse_github_url_ssh() {
  (
    eval "$(sed -n '/^parse_github_url()/,/^}/p' "$LIB1_PATH")"
    PARSED_USERNAME="" PARSED_REPONAME="" PARSED_CANONICAL_URL=""
    parse_github_url "git@github.com:myorg/myrepo.git"
    assert_equals "myorg" "$PARSED_USERNAME" "username from SSH URL"
    assert_equals "myrepo" "$PARSED_REPONAME" "reponame from SSH URL"
    assert_equals "git@github.com:myorg/myrepo" "$PARSED_CANONICAL_URL" "canonical SSH URL"
  )
}

test_parse_github_url_ssh_protocol() {
  (
    eval "$(sed -n '/^parse_github_url()/,/^}/p' "$LIB1_PATH")"
    PARSED_USERNAME="" PARSED_REPONAME="" PARSED_CANONICAL_URL=""
    parse_github_url "ssh://git@github.com/user/repo"
    assert_equals "user" "$PARSED_USERNAME" "username from ssh:// URL"
    assert_equals "repo" "$PARSED_REPONAME" "reponame from ssh:// URL"
  )
}

test_parse_github_url_with_dotgit() {
  (
    eval "$(sed -n '/^parse_github_url()/,/^}/p' "$LIB1_PATH")"
    PARSED_USERNAME="" PARSED_REPONAME="" PARSED_CANONICAL_URL=""
    parse_github_url "https://github.com/user/repo.git"
    assert_equals "user" "$PARSED_USERNAME" "username strips .git"
    assert_equals "repo" "$PARSED_REPONAME" "reponame strips .git"
  )
}

test_parse_github_url_trailing_slash() {
  (
    eval "$(sed -n '/^parse_github_url()/,/^}/p' "$LIB1_PATH")"
    PARSED_USERNAME="" PARSED_REPONAME="" PARSED_CANONICAL_URL=""
    parse_github_url "https://github.com/user/repo/"
    assert_equals "user" "$PARSED_USERNAME" "username with trailing slash"
    assert_equals "repo" "$PARSED_REPONAME" "reponame with trailing slash"
  )
}

test_parse_github_url_invalid() {
  (
    eval "$(sed -n '/^parse_github_url()/,/^}/p' "$LIB1_PATH")"
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
    eval "$(sed -n '/^normalize_github_url_for_compare()/,/^}/p' "$LIB1_PATH")"
    eval "$(sed -n '/^resolve_target_remote()/,/^}/p' "$LIB1_PATH")"
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
    eval "$(sed -n '/^normalize_github_url_for_compare()/,/^}/p' "$LIB1_PATH")"
    eval "$(sed -n '/^resolve_target_remote()/,/^}/p' "$LIB1_PATH")"
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
    eval "$(sed -n '/^normalize_github_url_for_compare()/,/^}/p' "$LIB1_PATH")"
    eval "$(sed -n '/^resolve_target_remote()/,/^}/p' "$LIB1_PATH")"
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
    eval "$(sed -n '/^restore_remotes_from_backup()/,/^}/p' "$LIB1_PATH")"
    restore_remotes_from_backup "$repo" "$dir/remotes.tsv"
    local remotes
    remotes="$(git -C "$repo" remote -v)"
    assert_contains "$remotes" $'origin\thttps://github.com/test/repo (fetch)' "fetch URL should be restored"
    assert_contains "$remotes" $'origin\tgit@github.com:test/repo.git (push)' "push URL should be restored"
  )
}

test_push_branch_and_tags_does_not_publish_tags() {
  (
    eval "$(sed -n '/^push_branch_and_tags()/,/^}/p' "$LIB1_PATH")"
    CAPTURED_COMMANDS=""
    run_cmd() {
      CAPTURED_COMMANDS+="$*\n"
      return 0
    }
    push_branch_and_tags "/tmp/repo" "origin" "main" true || return 1
    assert_contains "$CAPTURED_COMMANDS" "git -C /tmp/repo push -u origin --force main" "branch push should still run"
    assert_not_contains "$CAPTURED_COMMANDS" "--tags" "tag pushes should be suppressed after history rewrite"
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
      python3 -c "
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
    python3 -c "
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
    python3 -c "
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
    python3 -c "
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
  consecutive=$(echo "$result" | python3 -c "
import re, sys
text = sys.stdin.read()
print(1 if re.search(r'\n{3,}', text) else 0)
")
  if [[ "$consecutive" != "0" ]]; then
    echo "    Expected blank lines to be collapsed to max 2 newlines"
    return 1
  fi
}
