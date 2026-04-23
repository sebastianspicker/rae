---
status: stable
owner: science
last_reviewed: 2026-04-12
source_of_truth: ../../reference/architecture/system-overview.md
evidence_links: ../../reference/claims/evidence-index.md
---

# Implementation Map

## Scientific idea to implementation surface

| Idea | Umbrella surface | Primary code anchor |
| --- | --- | --- |
| staged validation reduces self-certification risk | orchestration package | `packages/orchestration/scripts/pipeline/runner.mjs` |
| deterministic control surfaces improve auditability | Ralph loop | `packages/loops/ralph/ralph.sh` |
| narrow destructive tooling should stay explicit | repo-hygiene tool | `tools/repo-hygiene/coauthor-trailer-cleaner/coauthor-trailer-cleaner.sh` |
| benchmark claims need frozen metadata | eval schemas | `evals/schemas/*.json` |
| documentation quality is part of reliability | docs + verify layer | `scripts/verify_repo.py` |

## Reading rule

Use this page to move from theory to code. Use the package READMEs for the
detailed command surfaces.

## Related dossiers

- [CLM-014 staged separation](../../reference/claims/dossiers/clm-014-staged-separation.md)
- [CLM-017 documentation reliability](../../reference/claims/dossiers/clm-017-documentation-reliability.md)
- [CLM-010 reproducibility layers](../../reference/claims/dossiers/clm-010-reproducibility-layers.md)

## Interpretation limits

- code remains the source of truth for behavior
- this page is a traceability map, not empirical validation by itself

## Source note

- [Anthropic effective agents](../../reference/claims/bibliography.md#src-anthropic-effective-agents)
- [Diataxis](../../reference/claims/bibliography.md#src-diataxis)
- [NIST GenAI Profile](../../reference/claims/bibliography.md#src-nist-genai-profile)
- [Model Cards](../../reference/claims/bibliography.md#src-model-cards)
- [Datasheets](../../reference/claims/bibliography.md#src-datasheets)
- [OpenAI evals guidance](../../reference/claims/bibliography.md#src-openai-evals)
- [PaperBench](../../reference/claims/bibliography.md#src-openai-paperbench)
