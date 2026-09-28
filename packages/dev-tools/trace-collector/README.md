# Trace Collector

This package validates `trace.jsonl` execution events against
`packages/contracts/v1/schemas/artifacts/execution-trace.schema.json` and
returns deterministic summary metrics. It reads one JSON request from standard
input and writes a run-result envelope to standard output.

## Usage

Build the package before invoking its compiled entry point:

```bash
echo '{ ... }' | node dist/index.js
```

## Input

- `run_id` (string)
- either `events` (an array of trace events) or `trace_path` (a JSONL path)
- optional `schema_ref`; the execution-trace schema is the default

## Output

- `valid` flag
- list of `issues`
- summary metrics for event and gate counts, phase duration, tokens, cost,
  failures, and retries

## Development

Run from the repository root after `npm ci`:

```bash
npm --prefix packages/dev-tools/trace-collector run lint
npm --prefix packages/dev-tools/trace-collector run format:check
npm --prefix packages/dev-tools/trace-collector run build
```

This package has no standalone test script; its contract is exercised by the
engine and repository verification suites.

## Locked container build and protocol checks

Build with the repository root as the context:

```bash
docker build -f packages/dev-tools/trace-collector/sandbox/Dockerfile -t rae-trace-collector .
docker run --rm rae-trace-collector --healthcheck
```

The image compiles the shared package and this tool with the root workspace
lockfile, includes the versioned schemas, and runs as the existing non-root
`skill` user. From a prepared checkout, `node --test
packages/dev-tools/tests/protocol.test.ts` exercises all three compiled tools
and their supported runner exports. CI runs the same protocol fixtures against
all three container images. These are deterministic local evaluations without
provider calls.
