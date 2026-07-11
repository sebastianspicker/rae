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
state, reports, and tuning summaries stay untracked under `.codacy/`. Because
Analysis CLI 0.11.0 bundles older Ruff, Bandit, Checkov, and Biome adapters,
the gate runs the policy-pinned native versions directly and records their
versions plus successful completion in
`.codacy/reports/codacy-local-native-tool-versions.json`. The remaining tools
run through a generated, temporary Codacy configuration with
`--fail-if-missing` and exact adapter-version checks. Raw JSON stays under
`.codacy/tmp/`; the committed sanitizer strips source content before writing
`.codacy/reports/codacy-local-sanitized.json`. Any unavailable, failed,
partial, version-mismatched, or finding-producing analysis exits nonzero.
