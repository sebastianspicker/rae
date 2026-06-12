# Security Policy

## Reporting route

Please report security issues privately before opening a public issue.

- Preferred route: email the maintainer listed on
  [the repository hosting page](https://github.com/sebastianspicker/rae).
- Include: affected path(s), reproduction steps, impact, and whether public
  disclosure appears to have already occurred.

Do not include live secrets in the initial report.

## Scope

This repository contains documentation, evaluation harness scaffolding, and public-facing agent/tooling profiles.

Supported scope for coordinated handling:

- the default branch of this repository
- committed package runtimes under `packages/`
- committed umbrella scripts under `scripts/`
- committed tooling under `tools/`
- committed eval harness and schemas under `evals/`
- committed public profile lane content under `profiles/agent-environments/`

Out of scope:

- private overlays or unpublished downstream copies
- generated local artifacts under ignored temp/result locations
- third-party hosted services not controlled by this repository

Do not publish:

- secrets
- tokens
- local machine paths that expose private structure without reason
- personal debug logs
- private overlay material extracted from non-public repos

## Handling expectations

- acknowledgement target: within 7 calendar days
- initial triage target: within 14 calendar days
- coordinated fix/disclosure timing depends on severity and reproducibility
- if the report is out of scope, the response should say so explicitly

## Current security boundaries

- public agent profiles must remain machine-agnostic
- public profile installers must refuse symlinked managed paths and manifest
  backup paths that escape the target tree
- benchmark artifacts must avoid sensitive repository content
- maintenance tooling examples must avoid destructive defaults
- evaluation and publication gates must reject forged or out-of-bounds evidence
