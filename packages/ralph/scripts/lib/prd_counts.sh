# shellcheck shell=bash
# PRD story count helpers. Usage: prd_total_stories <prd_file>, etc.

prd_total_stories() {
  jq '[.stories[]] | length' "$1"
}

prd_passed_stories() {
  jq '[.stories[] | select(.passes == true)] | length' "$1"
}

prd_skipped_stories() {
  jq '[.stories[] | select((.skipped // false) == true)] | length' "$1"
}
