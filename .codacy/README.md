# Local Codacy policy

`.codacy/codacy.config.json` defines the repository's local Analysis CLI
policy. Run it with:

```bash
node scripts/dist/codacy-local.js
```

The script runs pinned Biome, the TypeScript AST complexity check and native
Trivy configuration scanning, then invokes the selected Hadolint, markdownlint,
Trivy, OpenGrep and Jackson adapters through the pinned Codacy launcher. It
fails when a required analyzer is unavailable, reports an unexpected version,
does not complete, or produces a finding.

Generated configuration, raw output, and sanitized reports stay untracked
under `.codacy/`. The checked-in report sanitizer removes source content from
the JSON report before it is retained locally or uploaded by CI.
