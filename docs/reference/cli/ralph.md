---
status: experimental
owner: loops
last_reviewed: 2026-07-24
source_of_truth: packages/ralph/src/cli.ts
evidence_links: ../claims/evidence-index.md
---

# Ralph CLI

Ralph is the repository's story-driven audit, linting, and scoped-fixing loop.
The umbrella entrypoint is:

```bash
npm run rae -- ralph --help
```

Common commands:

```bash
npm run rae -- ralph --check
npm run rae -- ralph --mode audit 20
npm run rae -- ralph --mode linting 10
npm run rae -- ralph --mode fixing 5
npm run rae -- ralph --status --status-format json
```

`audit` and `linting` are read-only. `fixing` uses an external workspace,
immutable baseline, private transaction journal, quarantine, and no-clobber
promotion. macOS and Linux provide the required promotion primitive;
unsupported platforms fail closed.

`prd.json` defines stories and acceptance criteria. It is local runtime state.
Use `packages/ralph/prd.json.example` as the public template.

The complete command, environment, runtime-file, recovery, and security
reference is the
[Ralph package README](https://github.com/sebastianspicker/rae/blob/main/packages/ralph/README.md).

## Source note

- [Diataxis](../claims/bibliography.md#src-diataxis)
- [NIST GenAI Profile](../claims/bibliography.md#src-nist-genai-profile)
- [IEEE 1012](../claims/bibliography.md#src-ieee-1012)
- [Model Cards](../claims/bibliography.md#src-model-cards)
- [Datasheets](../claims/bibliography.md#src-datasheets)
- [Pineau reproducibility report](../claims/bibliography.md#src-pineau-reproducibility)
- [Nosek open research culture](../claims/bibliography.md#src-nosek-open-research)
