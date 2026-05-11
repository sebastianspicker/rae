# Orchestration Policy

## Objective

Keep orchestration explicit. The runtime does not auto-scale reviewer or builder
fan-out from cost estimates, budgets, or inferred quality gain.

## Rule

- Use the stage order and gates defined by the pipeline.
- Use only reviewer or builder assignments already declared in the approved
  phase contract or artifact.
- Do not add extra workers during runtime execution.
- If a task needs more parallel work, update the plan first and re-run the
  relevant gate.

## Runtime Guardrails

- Pipeline state stores feature flags, context budgets, cognitive tiers, and
  artifact pointers.
- It does not store automatic fan-out policy parameters.
- Trace events record executed phases, artifact reads/writes, task sessions, and
  gate outcomes. They do not record synthetic policy decisions.
