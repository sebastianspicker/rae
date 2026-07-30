#!/usr/bin/env bash
# Builds the GitHub Pages demo from the canonical operator UI plus the fixture adapter.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ORCHESTRATION_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
REPOSITORY_ROOT="$(cd "$ORCHESTRATION_ROOT/../.." && pwd)"
STATIC_ROOT="$ORCHESTRATION_ROOT/operator/static"
DEMO_ROOT="$ORCHESTRATION_ROOT/operator/demo"
OUTPUT_ROOT="$REPOSITORY_ROOT/dist/pages-demo"

if [[ "${1:-}" == "--output" ]]; then
  [[ -n "${2:-}" && $# -eq 2 ]] || {
    echo "--output requires exactly one directory" >&2
    exit 2
  }
  case "$2" in
    /*) OUTPUT_ROOT="$2" ;;
    *) OUTPUT_ROOT="$PWD/$2" ;;
  esac
elif [[ $# -ne 0 ]]; then
  echo "usage: build-pages-demo.sh [--output directory]" >&2
  exit 2
fi

[[ -n "$OUTPUT_ROOT" && "$OUTPUT_ROOT" != "/" ]] || {
  echo "refusing unsafe output directory" >&2
  exit 2
}

rm -rf -- "$OUTPUT_ROOT"
mkdir -p "$OUTPUT_ROOT/demo"
cp -R "$STATIC_ROOT/." "$OUTPUT_ROOT/"
cp "$DEMO_ROOT/mock-api.js" "$OUTPUT_ROOT/demo/mock-api.js"
cp "$DEMO_ROOT/demo.css.txt" "$OUTPUT_ROOT/demo/demo.css"

INDEX="$OUTPUT_ROOT/index.html"

replace_once() {
  local needle="$1"
  local replacement="$2"
  local count
  count="$(NEEDLE="$needle" perl -0777 -ne '$count = () = /\Q$ENV{NEEDLE}\E/g; print $count' "$INDEX")"
  [[ "$count" == "1" ]] || {
    echo "expected exactly one canonical HTML anchor: $needle" >&2
    exit 1
  }
  NEEDLE="$needle" REPLACEMENT="$replacement" perl -0777 -i -pe \
    'BEGIN { $needle = $ENV{NEEDLE}; $replacement = $ENV{REPLACEMENT} } s/\Q$needle\E/$replacement/' \
    "$INDEX"
}

replace_once \
  "RAE Evidence Dossier — local Runboard operator console for autonomous repository runs." \
  "RAE Evidence Dossier static simulation using sanitized fixture data. No command is run."
replace_once \
  "<title>RAE Evidence Dossier</title>" \
  "<title>RAE Evidence Dossier · Static simulation</title>"
replace_once \
  '<link rel="stylesheet" href="/styles.css">' \
  $'<link rel="stylesheet" href="./styles.css">\n    <link rel="stylesheet" href="./demo/demo.css">'
replace_once \
  '<script type="module" src="/app.js"></script>' \
  '<script type="module" src="./demo/mock-api.js"></script>'
replace_once \
  "  <body>" \
  $'  <body>\n    <aside class="demo-notice" role="note">\n      <strong>Static simulation</strong>\n      <span>Sanitized fixture data. No command is run and no state is saved.</span>\n      <a href="https://github.com/sebastianspicker/rae">View repository</a>\n    </aside>'

touch "$OUTPUT_ROOT/.nojekyll"
echo "Built static demo at $OUTPUT_ROOT"
