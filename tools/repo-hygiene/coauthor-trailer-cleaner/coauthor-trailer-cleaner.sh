#!/usr/bin/env bash
# Starts the coauthor-trailer cleaner with its validated runtime and sourced policy modules.
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=tools/repo-hygiene/coauthor-trailer-cleaner/lib/runtime.sh
source "$SCRIPT_DIR/lib/runtime.sh"
# shellcheck source=tools/repo-hygiene/coauthor-trailer-cleaner/lib/common.sh
source "$SCRIPT_DIR/lib/common.sh"
# shellcheck source=tools/repo-hygiene/coauthor-trailer-cleaner/lib/config.sh
source "$SCRIPT_DIR/lib/config.sh"
# shellcheck source=tools/repo-hygiene/coauthor-trailer-cleaner/lib/git-workflow.sh
source "$SCRIPT_DIR/lib/git-workflow.sh"
# shellcheck source=tools/repo-hygiene/coauthor-trailer-cleaner/lib/cli.sh
source "$SCRIPT_DIR/lib/cli.sh"

trap cleanup_temp_files EXIT
coauthor_require_runtime
coauthor_cleaner_main "$@"
