---
status: stable
owner: core
last_reviewed: 2026-07-10
source_of_truth: ../reference/contracts/quality-gates.md
evidence_links: ../reference/invariants/determinism-contracts.md
---

# Quality Policy

RAE uses layered local checks so that fast feedback does not replace security
or release verification. The authoritative release command remains
`npm run verify --`; quality reports are evidence for review, not a claim of
Cloud reanalysis.

## Local tool policy

- Strict TypeScript compilation checks package interfaces and validated input
  handling. Biome 2.5.2 checks maintained source and respects version-control
  ignore rules.
- The TypeScript AST checker enforces function complexity 12, code lines 80,
  and 8 parameters. It excludes test fixtures and declaration files, and
  reports each violating function without a repository-wide waiver.
- The separate local Codacy command runs Hadolint, markdownlint, Trivy,
  OpenGrep and Jackson through the pinned Analysis CLI. Native Trivy
  misconfiguration scanning replaces the Python Checkov runtime; Biome and
  TypeScript replace Python and shell language checks for the migrated code.
  These scanners cover different rule sets, so results must identify the tool
  and version that produced each finding.

The checked-in Codacy configuration also records imported analyzer policies.
The Node runner selects the applicable adapters and records native checks
separately. This does not change Codacy Cloud settings or constitute Cloud
reanalysis. New analyzer exceptions require an exact rule identifier, a named
replacement control and review evidence.

## Evidence boundary

Run `node scripts/dist/codacy-local.js` to check native tools and inspect the selected adapters,
then produce a sanitized local JSON report under the ignored
`.codacy/reports/` directory. The raw full JSON remains only under the ignored
`.codacy/tmp/` directory; the sanitized report removes `lineContent`. The
command fails for unavailable, failed, partial, version-mismatched, or
finding-producing analysis. The script pins
`@codacy/analysis-cli@0.11.0` with `npm exec`; its `-V` output currently says
`0.0.1`, so the pinned package spec—not that self-report—is the version
authority. Local analysis does not change Codacy Cloud or override the
organization Coding Standard.

## External references

- [Codacy repository configuration](https://docs.codacy.com/repositories-configure/codacy-configuration-file/)
- [Ruff linter configuration](https://docs.astral.sh/ruff/linter/)
- [Biome 2.5 release guidance](https://biomejs.dev/blog/biome-v2-5/)
- [Bandit documentation](https://bandit.readthedocs.io/en/latest/)
- [OpenGrep 1.22.0 release](https://github.com/opengrep/opengrep/releases/tag/v1.22.0)
- [Checkov CLI reference](https://www.checkov.io/2.Basics/CLI%20Command%20Reference.html)
- [Trivy scanner documentation](https://trivy.dev/docs/latest/scanner/)
- [ShellCheck project documentation](https://www.shellcheck.net/)

## Source note

- [NIST GenAI Profile](../reference/claims/bibliography.md#src-nist-genai-profile)
- [IEEE 1012 verification and validation](../reference/claims/bibliography.md#src-ieee-1012)
- [Pineau reproducibility report](../reference/claims/bibliography.md#src-pineau-reproducibility)
- [OpenAI evals guidance](../reference/claims/bibliography.md#src-openai-evals)
- [Anthropic effective agents](../reference/claims/bibliography.md#src-anthropic-effective-agents)
- [Bainbridge automation](../reference/claims/bibliography.md#src-bainbridge-automation)
- [Endsley situation awareness](../reference/claims/bibliography.md#src-endsley-situation-awareness)
