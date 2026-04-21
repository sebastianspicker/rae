---
status: stable
owner: science
last_reviewed: 2026-04-17
source_of_truth: ../claims-ledger.md
evidence_links: ../evidence-index.md#clm-006
---

# CLM-006 Benchmark Contamination

## Claim statement

Public coding benchmarks require contamination-aware interpretation and should
not be treated as sufficient evidence in isolation.

## Claim class

`governance_rule`

## Proof mode

Governance rule grounded in documented contamination events on public
benchmarks; operationalised by the RAE benchmark protocol's contamination
analysis requirement.

## Assumptions

- training data exposure to benchmark tasks is a persistent risk for any public
  benchmark
- contamination cannot always be fully measured; partial analysis is still
  informative
- internal frozen benchmarks are designed to reduce (not eliminate) the
  contamination surface

## Internal anchors

- `docs/research/benchmark-protocol.md`

## External anchors

- [OpenAI on SWE-bench contamination and flawed tests](../bibliography.md#src-openai-swebench-verified)
- [NIST GenAI Profile](../bibliography.md#src-nist-genai-profile)
- [PaperBench](../bibliography.md#src-openai-paperbench)
- [OpenAI evals guidance](../bibliography.md#src-openai-evals)
- [Pineau reproducibility report](../bibliography.md#src-pineau-reproducibility)
- [Model Cards](../bibliography.md#src-model-cards)
- [Datasheets](../bibliography.md#src-datasheets)

## Benchmark artifacts

None required; this is a publication policy rule rather than a performance
claim.

## Counterarguments

- full contamination analysis is expensive and may not be feasible for all
  benchmark families
- contamination concern can be used to discount legitimately strong results

## Validity threats

- contamination analysis methodology is not yet standardised; results across
  labs may not be directly comparable
- the rule addresses training-time exposure but not evaluation-time data leakage

## Review status

Adopted as a mandatory interpretation precondition for all external benchmark
citations.

## Source note

- [OpenAI on SWE-bench contamination and flawed tests](../bibliography.md#src-openai-swebench-verified)
- [NIST GenAI Profile](../bibliography.md#src-nist-genai-profile)
- [PaperBench](../bibliography.md#src-openai-paperbench)
- [OpenAI evals guidance](../bibliography.md#src-openai-evals)
- [Pineau reproducibility report](../bibliography.md#src-pineau-reproducibility)
- [Model Cards](../bibliography.md#src-model-cards)
- [Datasheets](../bibliography.md#src-datasheets)
