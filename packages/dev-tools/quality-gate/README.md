# Quality gate

This package validates a JSON artifact against a JSON Schema and evaluates
deterministic acceptance criteria. It reads one JSON request from standard
input and writes a run-result envelope to standard output.

## Usage

Build the package before invoking its compiled entry point:

```bash
echo '{ ... }' | node dist/index.js
```

## Input

```json
{
  "artifact": { "title": "My Design", "sections": ["a", "b"] },
  "artifact_ref": ".pipeline/runs/<run-id>/design.json",
  "schema_ref": "schemas/design.schema.json",
  "phase": "design",
  "criteria": [
    { "name": "has-title", "type": "field-exists", "path": "title" },
    { "name": "min-sections", "type": "count-min", "path": "sections", "value": 2 },
    { "name": "no-open-questions", "type": "field-empty", "path": "open_questions" },
    { "name": "semver-version", "type": "regex-match", "path": "version", "value": "^\\d+\\.\\d+\\.\\d+$" }
  ]
}
```

- `artifact`: JSON value to validate.
- `artifact_ref`: optional reference recorded in the result.
- `schema_ref`: JSON Schema path resolved within the workspace.
- `phase`: phase name recorded in the result.
- `criteria`: deterministic checks evaluated after schema validation.

### Criterion types

| Type | Description | `value` |
| --- | --- | --- |
| `field-exists` | Field at `path` exists and is non-null | None |
| `field-empty` | Array at `path` has length 0 | None |
| `count-min` | Array at `path` has at least N items | number |
| `count-max` | Array at `path` has at most N items | number |
| `number-max` | Number at `path` is less than or equal to N | number |
| `coverage-min` | Coverage ratio of source IDs found in target paths meets threshold | number (0..1) |
| `regex-match` | String at `path` matches regex | pattern string |

For `coverage-min`, supply:

- `source_path` (array path),
- optional `source_filter_path` and `source_filter_value`,
- `target_paths` (one or more paths inspected for coverage IDs).

## Output

```json
{
  "success": true,
  "data": {
    "gate_id": "uuid",
    "phase": "design",
    "status": "pass",
    "criteria": [
      { "name": "has-title", "passed": true, "evidence": "..." }
    ],
    "blocking_failures": [],
    "artifact_ref": ".pipeline/runs/<run-id>/design.json",
    "schema_validation": { "valid": true, "errors": [] },
    "timestamp": "2026-02-22T00:00:00.000Z"
  },
  "metadata": { "tool_version": "0.1.0", "execution_time_ms": 5 },
  "logs": ["..."]
}
```

## Development

Run from the repository root after `npm ci`:

```bash
npm --prefix packages/dev-tools/quality-gate run lint
npm --prefix packages/dev-tools/quality-gate run format:check
npm --prefix packages/dev-tools/quality-gate run build
```

This package has no standalone test script; its contract is exercised by the
engine and repository verification suites.

## Locked container build and protocol checks

Build with the repository root as the context:

```bash
docker build -f packages/dev-tools/quality-gate/sandbox/Dockerfile -t rae-quality-gate .
docker run --rm rae-quality-gate --healthcheck
```

The image compiles the shared package and this tool with the root workspace
lockfile, includes the versioned schemas, and runs as the existing non-root
`skill` user.
