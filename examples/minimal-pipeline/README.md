# Minimal Pipeline Example

This example is runnable from the umbrella harness.

## Goal

Create a minimal orchestration run, execute the intake stage, and summarize the
result.

## Commands

```bash
./scripts/rae.sh orchestrate init
./scripts/rae.sh orchestrate run-stage \
  --run-id <run_id> \
  --phase arm \
  --config-id phased_default \
  --taskset examples/minimal-pipeline/taskset.json
./scripts/rae.sh orchestrate summarize-run --run-id <run_id> --format markdown
```

## Expected artifacts

- `.pipeline/pipeline-state.json`
- `.pipeline/runs/<run_id>/brief.json`
- `.pipeline/runs/<run_id>/gates/arm-gate.json`
- `.pipeline/runs/<run_id>/trace.jsonl`
