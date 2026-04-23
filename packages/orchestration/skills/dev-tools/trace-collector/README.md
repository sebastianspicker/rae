# Trace Collector

Validates `trace.jsonl` execution events against `contracts/artifacts/execution-trace.schema.json` and returns deterministic summary metrics.

## Usage

The skill reads JSON from stdin and writes a structured run result to stdout.

```bash
echo '{ ... }' | node dist/index.js
```

## Input

- `run_id` (string)
- either `events` (array of trace event objects) or `trace_path` (path to JSONL file)
- optional `schema_ref` (defaults to `contracts/artifacts/execution-trace.schema.json`)

## Output

- `valid` flag
- list of `issues`
- summary metrics:
  - event counts
  - gate status counts
  - phase durations
  - token/cost totals
  - failure/retry counters

## Development

```bash
npm install
npm run lint
npm run format:check
npm run build
npm test
```
