#!/usr/bin/env bash
set -euo pipefail

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

eval_id="eval-$(date -u +%Y%m%dT%H%M%SZ)"
taskset="docs/eval/tasksets/default.json"
repeats="1"
mode="shadow"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --eval-id)
      eval_id="${2:?missing value for --eval-id}"
      shift 2
      ;;
    --taskset)
      taskset="${2:?missing value for --taskset}"
      shift 2
      ;;
    --repeats)
      repeats="${2:?missing value for --repeats}"
      shift 2
      ;;
    --mode)
      mode="${2:?missing value for --mode}"
      shift 2
      ;;
    *)
      echo "Unknown argument: $1" >&2
      echo "Usage: $0 [--eval-id <id>] [--taskset <path>] [--repeats <n>] [--mode <shadow|enforce>]" >&2
      exit 2
      ;;
  esac
done

node "$root_dir/scripts/eval/run-matrix.mjs" \
  --root "$root_dir" \
  --eval-id "$eval_id" \
  --taskset "$taskset" \
  --repeats "$repeats" \
  --mode "$mode"
