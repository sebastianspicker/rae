# Orchestration Policy

## Objective

Use multi-agent orchestration only when expected quality gain exceeds additional inference and coordination cost.

## Scoring function

For candidate agent count `n`:

`delta(n) = quality_gain(n) - lambda * cost_delta(n) - mu * coordination_cost(n)`

Run multi-agent orchestration only when:

`delta(n) > min_expected_gain`

Otherwise fallback to the single-agent baseline.

## Inputs

- `quality_gain(n)`: estimated error reduction vs. single-agent baseline.
- `cost_delta(n)`: expected additional runtime/inference cost vs. single-agent baseline.
- `coordination_cost(n)`: expected overhead from fan-out, merge, and adjudication.
- `lambda`: cost sensitivity.
- `mu`: coordination sensitivity.
- `min_expected_gain`: minimum positive gain to justify orchestration.

## Defaults

- `max_reviewers = 3`
- `max_builders = 3`
- `latency_budget_s = 3600`
- `budget_usd = 50`
- `lambda = 1.0`
- `mu = 1.0`
- `min_expected_gain = 0.10`

## Runtime guardrails

- Never exceed `max_reviewers` or `max_builders`.
- If `budget_usd` would be exceeded, reduce parallelism and log policy fallback in trace.
- If `latency_budget_s` would be exceeded, prefer lower fan-out configuration.
- Every policy decision must be written to trace as `event=agent_call` with `metadata.policy_decision`.

## Versioning

- Store active policy parameters in `.pipeline/pipeline-state.json` under `config.orchestration_policy`.
- Emit each policy decision in trace events (`event=agent_call`, `metadata.policy_decision`) so runs remain auditable against the active policy parameters.
