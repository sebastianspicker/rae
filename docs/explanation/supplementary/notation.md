---
status: stable
owner: science
last_reviewed: 2026-04-17
source_of_truth: editorial
evidence_links: ../../reference/claims/claims-ledger.md
---

# Notation

This page fixes the symbols used across the science layer so the surrounding
arguments remain precise.

## Editorial contract

- Inline formulas use `$...$` and display formulas use `$$...$$`.
- Symbols defined here are the default symbols for the surrounding science
  pages.
- Display equations are unnumbered by default; add numbering only when a page
  refers back to the same equation repeatedly.
- The notation is explanatory and cross-page consistent; it is not a claim that
  the full socio-technical system is exactly parameterized.

## Core variables

- $I$
  Human or organizational intent.
- $C$
  Context presented to a model or runtime.
- $S$
  Signal-bearing part of context.
- $N$
  Noise or weakly relevant part of context.
- $Y$
  Output emitted by a model, stage, or loop.
- $A_k$
  Artifact produced at phase `k`.
- $G_k$
  Gate predicate or gate result attached to phase `k`.
- $X$
  Realized implementation or repository state.
- $D$
  Design artifact.
- $P$
  Plan artifact.
- $n$
  Number of active contributors, workers, or reviewers.

## Information-theoretic quantities

- $H(C)$
  Entropy or description length of context.
- $\mathcal{I}(I; C)$
  Mutual information between intent and provided context.
- $\mathrm{SNR}_{\text{info}}$
  Informal signal-density proxy, typically treated as
  $\mathcal{I}(I; C) / H(C)$.

## Reliability quantities

- $p_k$
  Probability that phase `k` introduces or preserves a harmful defect.
- $q_k$
  Probability that phase `k` detects a defect that already exists.
- $\operatorname{Drift}(D, X)$
  Drift score between design constraints and implementation.

## Coordination quantities

- $E_{\text{complete}}(n) = n(n-1)/2$
  Number of communication edges in a fully connected team.
- $E_{\text{star}}(n) = n-1$
  Number of edges in a hub-and-spoke topology.
- $C_{\text{coord}}(n)$
  Coordination cost under a chosen topology.

## Interpretation note

Most of the formalism in this repo is explanatory modeling, not a claim that the
full engineering process is closed-form or exactly measurable. The mathematical
objects are there to sharpen reasoning, surface assumptions, and constrain
claims.

## Related dossiers

- [CLM-007 information density](../../reference/claims/dossiers/clm-007-information-density.md)
- [CLM-008 coordination topology](../../reference/claims/dossiers/clm-008-coordination-topology.md)
- [CLM-010 reproducibility layers](../../reference/claims/dossiers/clm-010-reproducibility-layers.md)

## Source note

- [Shannon 1948](../../reference/claims/bibliography.md#src-shannon-1948)
- [Cover and Thomas](../../reference/claims/bibliography.md#src-cover-thomas)
- [Transformer](../../reference/claims/bibliography.md#src-transformer)
- [Amdahl 1967](../../reference/claims/bibliography.md#src-amdahl-1967)
- [Conway 1968](../../reference/claims/bibliography.md#src-conway-1968)
- [Cohen kappa](../../reference/claims/bibliography.md#src-cohen-kappa)
- [Artstein and Poesio](../../reference/claims/bibliography.md#src-artstein-poesio)
