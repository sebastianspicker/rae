---
status: stable
owner: core
last_reviewed: 2026-04-12
source_of_truth: ../../how-to/choose-an-execution-model.md
evidence_links: ../../reference/claims/claims-ledger.md
---

# Decision Tree

- Need explicit staged validation, role separation, and typed handoffs:
  use orchestration.
- Need bounded, repeatable audit/lint/fix cycles with strict state mutation:
  use Ralph.
- Need a one-off maintenance operation with explicit destructive semantics:
  use a tool under `tools/`.
- Need to explain or publish the outcome:
  update the documentation and governance surfaces before release.

## Thesis validation

The decision tree is an operational compression of the broader claims about
smallest-adequate runtime choice, bounded coordination, and explicit evidence
production.

## Related dossiers

- [CLM-008 coordination topology](../../reference/claims/dossiers/clm-008-coordination-topology.md)
- [CLM-014 staged separation](../../reference/claims/dossiers/clm-014-staged-separation.md)
- [CLM-016 cognitive tiering](../../reference/claims/dossiers/clm-016-cognitive-tiering.md)

## Interpretation limits

- the tree is a routing heuristic, not an optimal policy theorem
- package-local docs still override this page for command behavior

## Source note

- [Anthropic effective agents](../../reference/claims/bibliography.md#src-anthropic-effective-agents)
- [Amdahl 1967](../../reference/claims/bibliography.md#src-amdahl-1967)
- [Bainbridge automation](../../reference/claims/bibliography.md#src-bainbridge-automation)
- [Parasuraman and Riley](../../reference/claims/bibliography.md#src-parasuraman-riley)
- [Endsley situation awareness](../../reference/claims/bibliography.md#src-endsley-situation-awareness)
- [NIST GenAI Profile](../../reference/claims/bibliography.md#src-nist-genai-profile)
- [Diataxis](../../reference/claims/bibliography.md#src-diataxis)
