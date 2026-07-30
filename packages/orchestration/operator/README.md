# RAE loopback operator console

Evidence Dossier UI for durable autonomous-run state under `.pipeline/`. It binds
only to `127.0.0.1`, uses an ephemeral port by default, and does not expose raw
provider traces. The static surface is a case-file layout (bound ledger table,
in-flow human checkpoint) served as modular CSS/JS under `static/css/` and
`static/js/`.

## Screenshots

Sanitized layout captures use the maintained CSS and fixture data. They are not
evidence from a real run:

![Evidence Dossier desktop](docs/screenshots/evidence-dossier-desktop.png)

![Evidence Dossier mobile](docs/screenshots/evidence-dossier-mobile.png)

Start it with one or more canonical Git roots:

```bash
node packages/orchestration/operator/server.mjs \
  --project /absolute/path/to/repository
```

The supported umbrella form is:

```bash
./scripts/rae.sh operator serve --project /absolute/path/to/repository
```

The server prints one URL. Its 256-bit session token appears only in the URL
fragment. The app removes the fragment from browser history and keeps the token
in memory for bearer-authenticated API and event-stream requests.

## API

All `/api/v1` requests require the session bearer token and an exact loopback
`Host`. State-changing requests also require the exact loopback `Origin`.

- `GET /api/v1/projects`
- `GET|POST /api/v1/projects/:projectId/runs`
- `GET /api/v1/projects/:projectId/runs/:runId`
- `GET /api/v1/projects/:projectId/runs/:runId/events`
- `GET /api/v1/projects/:projectId/runs/:runId/events/stream`
- `POST .../:runId/stop`
- `POST .../:runId/resume`
- `POST .../:runId/interrupt`
- `POST .../:runId/checkpoint-decision`
- `POST .../:runId/cleanup`

Start accepts only `task` and `checkpoint_policy`. Interrupt and cleanup require
`confirm_run_id` to exactly match the selected run. A checkpoint decision
requires its opaque `checkpoint_id`, an opaque `decision_id`, one of `approve`,
`reject`, or `escalate`, and a non-empty `rationale`. The server records the
actor as `rae-loopback-operator`.

The console never accepts in-place execution, command providers, environment
overrides, raw trace access, forced cleanup, commit, push, or publish controls.
Cleanup delegates to the pipeline's ownership- and dirty-state-validating
worktree cleanup operation.

The workflow editor lists immutable revisions, renders synchronized SVG and
structured node/edge views, validates drafts, compares revisions, displays
budgets and activation history, and activates only after exact digest
confirmation. Native forms and the structured list provide every authoring
operation; canvas dragging is not required. Registry mutations are rejected
while any allowlisted project run is active.

Run projections include bounded graph health counts when a projection exists:
availability, validation state, node and edge counts, stale-source count, and
stale-memory and unresolved-conflict counts. The API does not expose raw graph records, absolute
paths, prompts, provider metadata, or untrusted memory text.

Only one process started by a server instance may be active at once. Interrupt
signals that owned process group, records `interrupted` after it exits, and
removes an autonomous lock only when its recorded PID matches the owned child.
POSIX process groups cannot prove termination of a descendant that deliberately
creates a new session, so interrupt responses expose `containment_uncertain`;
inspect the workspace and provider activity before reusing an interrupted run.
Start defaults to checkpoints before both mutation and release.

## Verification

```bash
node --test packages/orchestration/operator/tests/*.test.mjs
```
