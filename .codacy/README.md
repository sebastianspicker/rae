# Local Codacy policy

`.codacy/codacy.config.json` is a tracked, local Analysis CLI policy. It is
not a Codacy Cloud import request and must not be imported with `--force`.
The repository remains attached to the organization `Default coding standard`.

Run the strict local policy with:

```bash
bash scripts/codacy-local.sh
```

The script deliberately pins the launcher package rather than trusting the
launcher self-report:

```bash
npm exec --yes --package=@codacy/analysis-cli@0.11.0 -- codacy-analysis analyze
```

On 2026-07-10, that exact package invocation reported `0.0.1` for `-V` even
though npm resolved `@codacy/analysis-cli@0.11.0`. Treat the package spec as
the version authority and record the observed self-report mismatch in local
evidence; do not loosen the pin.

The policy uses Ruff, Bandit, Biome, Checkov, OpenGrep (whose CLI identifier is
`Semgrep`), ShellCheck, Lizard, Hadolint, Trivy, markdownlint, and Jackson.
Ruff and Biome use the repository-local configuration files. Generated CLI
state, reports, and tuning summaries stay untracked under `.codacy/`. The
script always inspects adapters first, requires Ruff 0.15.20, Bandit 1.9.4,
Checkov 3.3.7, and Biome 2.5.2, then runs with `--fail-if-missing`. It writes
raw JSON only to `.codacy/tmp/` and strips every `lineContent` field before
writing `.codacy/reports/codacy-local-sanitized.json`. Any unavailable,
failed, partial, version-mismatched, or finding-producing analysis exits
nonzero.
