---
status: stable
owner: science
last_reviewed: 2026-04-12
source_of_truth: editorial
evidence_links: ../../reference/claims/assumptions-register.md
---

# Limitations

RAE is a public reference system with explicit scope boundaries; it should be
read as an evidence-bearing engineering umbrella, not as a universal proof of
agent reliability.

## Current limits

- the public profile payload is intentionally generic; it is a safe baseline,
  not a full operator-specific environment
- the frozen benchmark families emphasize route correctness, artifact
  completeness, checkpoint discipline, and deterministic runtime behavior; they
  are not a universal measure of all agent performance
- contamination-aware interpretation still matters whenever results are used for
  broader capability claims

## Science-layer limits

- several equations in the science layer are explanatory rather than benchmark
  calibrated
- dossier coverage now exists for the core science claims, but not yet for the
  entire repository corpus
- the seven-source rule is locked, yet much of the operational corpus still
  needs its companion source packets in later tranches

## Practical implication

You can use the repo for public release, local verification, and benchmarked
operator workflows. You should not treat it as a complete proof that one single
architecture dominates every agent-engineering setting.

## Related dossiers

- [CLM-010 reproducibility layers](../../reference/claims/dossiers/clm-010-reproducibility-layers.md)
- [CLM-019 validity doctrine](../../reference/claims/dossiers/clm-019-validity-doctrine.md)

## Source note

- [NIST GenAI Profile](../../reference/claims/bibliography.md#src-nist-genai-profile)
- [Model Cards](../../reference/claims/bibliography.md#src-model-cards)
- [Datasheets](../../reference/claims/bibliography.md#src-datasheets)
- [Pineau reproducibility report](../../reference/claims/bibliography.md#src-pineau-reproducibility)
- [OpenAI on SWE-bench contamination](../../reference/claims/bibliography.md#src-openai-swebench-verified)
- [PaperBench](../../reference/claims/bibliography.md#src-openai-paperbench)
- [Lost in the Middle](../../reference/claims/bibliography.md#src-lost-in-the-middle)
