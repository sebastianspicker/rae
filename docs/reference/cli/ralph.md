---
status: experimental
owner: loops
last_reviewed: 2026-07-24
source_of_truth: packages/loops/ralph/ralph.sh
evidence_links: ../claims/evidence-index.md
---

# Ralph CLI

Ralph is the repository's story-driven audit, linting, and scoped-fixing loop.
The umbrella entrypoint is:

```bash
./scripts/rae.sh ralph --help
```

Common commands:

```bash
./scripts/rae.sh ralph --check
./scripts/rae.sh ralph --mode audit 20
./scripts/rae.sh ralph --mode linting 10
./scripts/rae.sh ralph --mode fixing 5
./scripts/rae.sh ralph --status --status-format json
```

`audit` and `linting` are read-only. `fixing` uses an external workspace,
immutable baseline, private transaction journal, quarantine, and no-clobber
promotion. macOS and Linux provide the required promotion primitive;
unsupported platforms fail closed.

`prd.json` defines stories and acceptance criteria. It is local runtime state.
Use `packages/loops/ralph/prd.json.example` as the public template.

The complete command, environment, runtime-file, recovery, and security
reference is the
[Ralph package README](../../../packages/loops/ralph/README.md).

## Source note

- [Diataxis](../claims/bibliography.md#src-diataxis)
- [NIST GenAI Profile](../claims/bibliography.md#src-nist-genai-profile)
- [IEEE 1012](../claims/bibliography.md#src-ieee-1012)
- [Model Cards](../claims/bibliography.md#src-model-cards)
- [Datasheets](../claims/bibliography.md#src-datasheets)
- [Pineau reproducibility report](../claims/bibliography.md#src-pineau-reproducibility)
- [Nosek open research culture](../claims/bibliography.md#src-nosek-open-research)
