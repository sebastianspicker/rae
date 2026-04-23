#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUTPUT_ROOT="${1:-}"
RESULTS_ROOT="$ROOT_DIR/evals/results"

if [[ -z "$OUTPUT_ROOT" ]]; then
  printf 'Usage: %s <output-root>\n' "$0" >&2
  exit 2
fi

OUTPUT_ROOT="$(
  python3 - "$OUTPUT_ROOT" <<'PY'
import os, sys
print(os.path.realpath(sys.argv[1]))
PY
)"

RESULTS_ROOT="$(
  python3 - "$RESULTS_ROOT" <<'PY'
import os, sys
print(os.path.realpath(sys.argv[1]))
PY
)"

if ! python3 - "$OUTPUT_ROOT" "$RESULTS_ROOT" <<'PY'; then
from pathlib import Path
import sys

output_root = Path(sys.argv[1]).resolve(strict=False)
results_root = Path(sys.argv[2]).resolve()
current = output_root if output_root.exists() else output_root.parent
ok = False
while True:
    try:
        if current.samefile(results_root):
            ok = True
            break
    except FileNotFoundError:
        pass
    if current == current.parent:
        break
    current = current.parent
if not ok:
    raise SystemExit(1)
PY
  printf 'ERROR: output-root must point under %s\n' "$RESULTS_ROOT" >&2
  exit 2
fi

mkdir -p "$OUTPUT_ROOT"

for benchmark_card in "$ROOT_DIR"/evals/benchmarks/*.benchmark-card.json; do
  benchmark_status="$(
    python3 - "$benchmark_card" <<'PY'
import json, sys
with open(sys.argv[1], encoding="utf-8") as handle:
    data = json.load(handle)
print(data.get("status", ""))
PY
  )"
  if [[ "$benchmark_status" != "frozen" ]]; then
    continue
  fi
  benchmark_name="$(basename "$benchmark_card" .benchmark-card.json)"
  for split in dev held-out; do
    output_dir="$OUTPUT_ROOT/$benchmark_name/$split"
    mkdir -p "$output_dir"
    python3 "$ROOT_DIR/evals/scripts/run_benchmark.py" \
      --benchmark-card "$benchmark_card" \
      --split "$split" \
      --output-dir "$output_dir" >/dev/null
  done
done

printf 'VERDICT: PASS\n'
