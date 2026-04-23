#!/usr/bin/env bash
# shellcheck shell=bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=tools/repo-hygiene/coauthor-trailer-cleaner/lib/coauthor-trailer-cleaner.part1.sh
source "$SCRIPT_DIR/lib/coauthor-trailer-cleaner.part1.sh"
# shellcheck source=tools/repo-hygiene/coauthor-trailer-cleaner/lib/coauthor-trailer-cleaner.part2.sh
source "$SCRIPT_DIR/lib/coauthor-trailer-cleaner.part2.sh"
# shellcheck source=tools/repo-hygiene/coauthor-trailer-cleaner/lib/coauthor-trailer-cleaner.part3.sh
source "$SCRIPT_DIR/lib/coauthor-trailer-cleaner.part3.sh"
