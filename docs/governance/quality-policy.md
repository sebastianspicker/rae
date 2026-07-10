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
`./scripts/verify.sh`; quality reports are evidence for review, not a claim of
Cloud reanalysis.

## Local tool policy

- Ruff targets Python 3.11 with a 100-character line length and enables only
  `E`, `F`, `W`, `I`, `UP`, `B`, `SIM`, `PIE`, and `RUF` families. Security
  findings are covered by Bandit rather than Ruff's `S` family.
- Biome covers JavaScript and TypeScript through
  `packages/orchestration/biome.json`; it uses the recommended rule preset and
  respects version-control ignore rules. TypeScript compilation remains
  package-local through each package's `tsc -p tsconfig.json` command.
- OpenGrep, ShellCheck, Hadolint, Checkov, Trivy, markdownlint, Jackson, and
  Lizard provide language, supply-chain, IaC, container, document, JSON, and
  complexity coverage. The full-repository local policy uses Lizard warnings at
  CCN 12, NLOC 80, and 8 parameters; critical thresholds are 20, 150, and 12.
  Changed code must also satisfy stricter organization standards reported by Cloud.

The local Codacy configuration does not enable ESLint 9, PyLint, Prospector,
PMD 7, Spectral, or Agentlinter. It preserves the existing narrowly scoped
configuration exclusions and adds no broad source, documentation, or test
exclusions.

## Exact analyzer exceptions

- Bandit `B404` is omitted because it reports imports rather than executable
  sinks; Bandit `B603` remains enabled for every subprocess call site.
- OpenGrep's Python `dangerous-subprocess-use-audit` rule is omitted because
  Bandit `B603` covers all 23 overlapping call sites and four additional
  sinks. Other OpenGrep command-injection rules remain enabled.
- OpenGrep alone excludes four parser-incompatible shell files: Ralph's
  `core.sh`, `status.sh`, and version-flag test, plus the orchestration
  integrity checker. Each file passes `bash -n` and ShellCheck; every other
  configured analyzer still scans them.

These are concern-level deduplications, not source-tree suppressions. Any new
exception requires an exact rule identifier, a named replacement control, and
review evidence in the local remediation ledger.

## Evidence boundary

Run `bash scripts/codacy-local.sh` to first inspect every configured adapter,
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
