#!/usr/bin/env bash
# Integration tests for coauthor-trailer-cleaner.sh

# ── Core Workflow Tests ─────────────────────────────────────────

test_single_repo_no_push() {
  skip_if_no_filter_repo || return 2
  local repo
  repo=$(setup_test_repo)
  local repo_name
  repo_name=$(basename "$repo")

  local before
  before=$(git -C "$repo" log --all --format='%B')
  assert_contains "$before" "$DEFAULT_TARGET_EMAIL" "test repo should contain default target trailers"

  local rc=0
  bash "$SCRIPT_PATH" --no-push "https://github.com/test/$repo_name" "$repo" >/dev/null 2>&1 || rc=$?
  assert_equals "0" "$rc" "default target rewrite should succeed"

  local after
  after=$(git -C "$repo" log --all --format='%B')
  assert_not_contains "$after" "$DEFAULT_TARGET_EMAIL" "default target trailers should be removed after rewrite"
  assert_contains "$after" "Add file2" "non-trailer commits should be preserved"
}

test_single_repo_defaults_to_local_only() {
  skip_if_no_filter_repo || return 2
  local repo repo_name before after
  repo=$(setup_test_repo)
  repo_name=$(basename "$repo")

  before=$(git -C "$repo" log --all --format='%B')
  bash "$SCRIPT_PATH" "https://github.com/test/$repo_name" "$repo" >/dev/null 2>&1
  after=$(git -C "$repo" log --all --format='%B')

  assert_not_contains "$after" "$DEFAULT_TARGET_EMAIL" "default execution should still rewrite locally"
  assert_contains "$after" "Add file2" "non-trailer commits should be preserved"
}

test_single_repo_custom_target() {
  skip_if_no_filter_repo || return 2
  local repo
  repo=$(setup_test_repo "Pair Bot" "pairbot@example.com")
  local repo_name
  repo_name=$(basename "$repo")

  local rc=0
  bash "$SCRIPT_PATH" --target "Pair Bot <pairbot@example.com>" --no-push \
    "https://github.com/test/$repo_name" "$repo" >/dev/null 2>&1 || rc=$?
  assert_equals "0" "$rc" "custom target rewrite should succeed"

  local after
  after=$(git -C "$repo" log --all --format='%B')
  assert_not_contains "$after" "pairbot@example.com" "custom target trailers should be removed"
}

test_single_repo_dry_run() {
  skip_if_no_filter_repo || return 2
  local repo
  repo=$(setup_test_repo)
  local repo_name
  repo_name=$(basename "$repo")

  local before
  before=$(git -C "$repo" log --all --format='%H %s')

  bash "$SCRIPT_PATH" --dry-run --no-push "https://github.com/test/$repo_name" "$repo" >/dev/null 2>&1

  local after
  after=$(git -C "$repo" log --all --format='%H %s')
  assert_equals "$before" "$after" "dry-run should not modify the repo"
}

test_validate_only() {
  local repo
  repo=$(setup_test_repo)
  local repo_name
  repo_name=$(basename "$repo")

  git -C "$repo" remote add origin "https://github.com/test/$repo_name"

  local rc=0
  bash "$SCRIPT_PATH" --validate-only "https://github.com/test/$repo_name" "$repo" >/dev/null 2>&1 || rc=$?
  assert_equals "0" "$rc" "validate-only should exit 0 for valid repo"

  local after
  after=$(git -C "$repo" log --all --format='%B')
  assert_contains "$after" "$DEFAULT_TARGET_EMAIL" "validate-only should not modify commits"
}

test_repo_without_matching_trailers() {
  skip_if_no_filter_repo || return 2
  local repo
  repo=$(setup_clean_test_repo)
  local repo_name
  repo_name=$(basename "$repo")

  local rc=0
  bash "$SCRIPT_PATH" --no-push "https://github.com/test/$repo_name" "$repo" >/dev/null 2>&1 || rc=$?
  assert_equals "0" "$rc" "repo without matching trailers should complete successfully"
}

test_dirty_worktree_rejected() {
  local repo repo_name rc
  repo=$(setup_test_repo)
  repo_name=$(basename "$repo")
  printf 'dirty\n' >>"$repo/file1.txt"

  rc=0
  bash "$SCRIPT_PATH" "https://github.com/test/$repo_name" "$repo" >/dev/null 2>&1 || rc=$?
  if [[ $rc -eq 0 ]]; then
    echo "    Expected non-zero exit for dirty worktree"
    return 1
  fi
}

test_push_rejected_when_branch_not_in_sync_with_upstream() {
  skip_if_no_filter_repo || return 2
  local repo repo_name remote_dir current_branch rc
  repo=$(setup_test_repo)
  repo_name=$(basename "$repo")
  current_branch=$(git -C "$repo" symbolic-ref --quiet --short HEAD)
  remote_dir=$(create_test_dir)/remote.git
  git init -q --bare "$remote_dir"
  git -C "$repo" remote add origin "$remote_dir"
  git -C "$repo" push -q -u origin "$current_branch"
  printf 'ahead\n' >"$repo/ahead.txt"
  git -C "$repo" add ahead.txt
  git -C "$repo" commit -q -m 'ahead'

  rc=0
  bash "$SCRIPT_PATH" --push "https://github.com/test/$repo_name" "$repo" >/dev/null 2>&1 || rc=$?
  if [[ $rc -eq 0 ]]; then
    echo "    Expected non-zero exit for ahead branch"
    return 1
  fi
}

# ── Error Handling Tests ────────────────────────────────────────

test_detached_head_rejected() {
  local repo
  repo=$(setup_test_repo)
  local repo_name
  repo_name=$(basename "$repo")
  git -C "$repo" remote add origin "https://github.com/test/$repo_name"

  git -C "$repo" checkout --detach HEAD 2>/dev/null

  local rc=0
  bash "$SCRIPT_PATH" --validate-only "https://github.com/test/$repo_name" "$repo" >/dev/null 2>&1 || rc=$?
  if [[ $rc -eq 0 ]]; then
    echo "    Expected non-zero exit for detached HEAD"
    return 1
  fi
}

test_relative_path_rejected() {
  local rc=0
  bash "$SCRIPT_PATH" --validate-only "https://github.com/test/repo" "relative/path/repo" >/dev/null 2>&1 || rc=$?
  if [[ $rc -eq 0 ]]; then
    echo "    Expected non-zero exit for relative path"
    return 1
  fi
}

test_nonexistent_path() {
  local rc=0
  bash "$SCRIPT_PATH" --validate-only "https://github.com/test/repo" "/nonexistent/path/repo" >/dev/null 2>&1 || rc=$?
  if [[ $rc -eq 0 ]]; then
    echo "    Expected non-zero exit for nonexistent path"
    return 1
  fi
}

test_not_git_repo() {
  local dir
  dir=$(create_test_dir)
  mkdir -p "$dir/not-a-repo"

  local rc=0
  bash "$SCRIPT_PATH" --validate-only "https://github.com/test/not-a-repo" "$dir/not-a-repo" >/dev/null 2>&1 || rc=$?
  if [[ $rc -eq 0 ]]; then
    echo "    Expected non-zero exit for non-git directory"
    return 1
  fi
}

test_invalid_url() {
  local repo
  repo=$(setup_test_repo)

  local rc=0
  bash "$SCRIPT_PATH" --validate-only "https://gitlab.com/user/repo" "$repo" >/dev/null 2>&1 || rc=$?
  if [[ $rc -eq 0 ]]; then
    echo "    Expected non-zero exit for non-GitHub URL"
    return 1
  fi
}

test_no_repos_specified() {
  local rc=0
  bash "$SCRIPT_PATH" >/dev/null 2>&1 || rc=$?
  if [[ $rc -eq 0 ]]; then
    echo "    Expected non-zero exit when no repos specified"
    return 1
  fi
}

# ── Config Tests ────────────────────────────────────────────────

test_config_file_defaults() {
  local repo
  repo=$(setup_test_repo)
  local repo_name
  repo_name=$(basename "$repo")
  local dir
  dir=$(create_test_dir)

  cat >"$dir/config.json" <<CONF
{
  "defaults": { "noPush": true },
  "targets": [{ "name": "Cursor", "email": "cursoragent@cursor.com" }],
  "repos": [{"url": "https://github.com/test/$repo_name", "path": "$repo"}]
}
CONF

  local rc=0
  bash "$SCRIPT_PATH" --config "$dir/config.json" --validate-only >/dev/null 2>&1 || rc=$?
  assert_equals "0" "$rc" "config with validate-only should succeed"
}

test_config_custom_target() {
  skip_if_no_filter_repo || return 2
  local repo
  repo=$(setup_test_repo "Pair Bot" "pairbot@example.com")
  local repo_name
  repo_name=$(basename "$repo")
  local dir
  dir=$(create_test_dir)

  cat >"$dir/config.json" <<CONF
{
  "defaults": { "noPush": true },
  "targets": [{ "name": "Pair Bot", "email": "pairbot@example.com" }],
  "repos": [{"url": "https://github.com/test/$repo_name", "path": "$repo"}]
}
CONF

  local rc=0
  bash "$SCRIPT_PATH" --config "$dir/config.json" >/dev/null 2>&1 || rc=$?
  assert_equals "0" "$rc" "config-defined custom target should succeed"

  local after
  after=$(git -C "$repo" log --all --format='%B')
  assert_not_contains "$after" "pairbot@example.com" "config-defined custom target should be removed"
}

# ── Repos File Tests ───────────────────────────────────────────

test_repos_file_plaintext() {
  local repo
  repo=$(setup_test_repo)
  local repo_name
  repo_name=$(basename "$repo")
  git -C "$repo" remote add origin "https://github.com/test/$repo_name"
  local dir
  dir=$(create_test_dir)

  echo "https://github.com/test/$repo_name $repo" >"$dir/repos.txt"

  local rc=0
  bash "$SCRIPT_PATH" --repos-file "$dir/repos.txt" --validate-only >/dev/null 2>&1 || rc=$?
  assert_equals "0" "$rc" "repos file with plaintext format should work"
}

test_repos_file_plaintext_accepts_hash_in_path() {
  local dir repo repo_name repo_path
  dir=$(create_test_dir)
  repo_path="$dir/repo#hash"
  mkdir -p "$repo_path"
  git -C "$repo_path" init -q
  git -C "$repo_path" config user.name "Test User"
  git -C "$repo_path" config user.email "test@test.local"
  printf 'demo\n' >"$repo_path/README.md"
  git -C "$repo_path" add README.md
  git -C "$repo_path" commit -q -m "Initial commit"
  repo_name="plain-hash-repo"
  git -C "$repo_path" remote add origin "https://github.com/test/$repo_name"

  printf 'https://github.com/test/%s %s\n' "$repo_name" "$repo_path" >"$dir/repos.txt"

  local rc=0
  bash "$SCRIPT_PATH" --repos-file "$dir/repos.txt" --validate-only >/dev/null 2>&1 || rc=$?
  assert_equals "0" "$rc" "repos file should preserve # in plaintext paths"
}

test_repos_file_json() {
  local repo
  repo=$(setup_test_repo)
  local repo_name
  repo_name=$(basename "$repo")
  git -C "$repo" remote add origin "https://github.com/test/$repo_name"
  local dir
  dir=$(create_test_dir)

  cat >"$dir/repos.json" <<CONF
[{"url": "https://github.com/test/$repo_name", "path": "$repo"}]
CONF

  local rc=0
  bash "$SCRIPT_PATH" --repos-file "$dir/repos.json" --validate-only >/dev/null 2>&1 || rc=$?
  assert_equals "0" "$rc" "repos file with JSON array format should work"
}

# ── Batch Processing Tests ──────────────────────────────────────

test_batch_two_repos() {
  skip_if_no_filter_repo || return 2
  local repo1 repo2
  repo1=$(setup_test_repo)
  repo2=$(setup_test_repo "Pair Bot" "pairbot@example.com")
  local name1 name2
  name1=$(basename "$repo1")
  name2=$(basename "$repo2")

  local rc=0
  bash "$SCRIPT_PATH" --no-push \
    "https://github.com/test/$name1" "$repo1" \
    "https://github.com/test/$name2" "$repo2" >/dev/null 2>&1 || rc=$?
  assert_equals "0" "$rc" "batch of two repos should succeed with default targets"

  local after1 after2
  after1=$(git -C "$repo1" log --all --format='%B')
  after2=$(git -C "$repo2" log --all --format='%B')
  assert_not_contains "$after1" "$DEFAULT_TARGET_EMAIL" "default-target repo should be cleaned"
  assert_contains "$after2" "pairbot@example.com" "non-target repo should remain untouched"
}

test_batch_one_fails() {
  local repo
  repo=$(setup_test_repo)
  local name
  name=$(basename "$repo")

  local rc=0
  bash "$SCRIPT_PATH" --validate-only \
    "https://github.com/test/$name" "$repo" \
    "https://github.com/test/bad" "/nonexistent/bad" >/dev/null 2>&1 || rc=$?

  if [[ $rc -eq 0 ]]; then
    echo "    Expected non-zero exit for batch with one invalid repo"
    return 1
  fi
}

test_push_phase_failure_restores_local_branch() {
  skip_if_no_filter_repo || return 2
  local repo repo_name before_head dir remote_dir rc after_head
  repo=$(setup_test_repo)
  repo_name=$(basename "$repo")
  before_head=$(git -C "$repo" rev-parse HEAD)
  dir=$(create_test_dir)
  remote_dir="$dir/non-github-remote.git"
  git init -q --bare "$remote_dir"
  git -C "$repo" remote add origin "$remote_dir"
  git -C "$repo" push -q -u origin "$(git -C "$repo" symbolic-ref --quiet --short HEAD)"

  bash "$SCRIPT_PATH" --push "https://github.com/test/$repo_name" "$repo" >/dev/null 2>&1 || rc=$?
  if [[ ${rc:-0} -eq 0 ]]; then
    echo "    Expected non-zero exit when push remote cannot be resolved"
    return 1
  fi

  after_head=$(git -C "$repo" rev-parse HEAD)
  assert_equals "$before_head" "$after_head" "push-phase failure should restore the original local branch state"
}
