#!/usr/bin/env bash
set -euo pipefail

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root_dir"

deleted=0

delete_matches() {
  local pattern="$1"
  while IFS= read -r path; do
    [[ -z "$path" ]] && continue
    rm -f "$path"
    echo "removed: $path"
    deleted=$((deleted + 1))
  done < <(find . -type f -name "$pattern" -not -path "./.git/*")
}

delete_matches ".DS_Store"
delete_matches "Thumbs.db"
delete_matches "*.swp"
delete_matches "*.swo"
delete_matches "*.tmp"
delete_matches "*.bak"
delete_matches "*.orig"

for cache_dir in ".pytest_cache" ".mypy_cache" ".ruff_cache"; do
  if [[ -d "$cache_dir" ]]; then
    rm -rf "$cache_dir"
    echo "removed: $cache_dir/"
    deleted=$((deleted + 1))
  fi
done

echo "cleanup complete: removed $deleted item(s)"

