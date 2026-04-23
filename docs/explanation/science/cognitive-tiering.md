---
status: stable
owner: science
last_reviewed: 2026-04-12
source_of_truth: editorial
evidence_links: ../../reference/claims/evidence-index.md
---

# Cognitive Tiering

Not every phase deserves the same reasoning budget, autonomy, or review burden.

## Claim

This page supports the heuristic claim that cognition should be allocated as a
budgeted control decision rather than fixed at one global maximum.

## 1. Tiering idea

Different tasks occupy different positions in a tradeoff space:

- consequence of error
- ambiguity of the task
- availability of mechanized checks
- cost sensitivity

Let a task-risk vector be:

$$
\tau = (a, r, m, c)
$$

where $a$ is ambiguity, $r$ is consequence of error, $m$ is mechanized
checkability, and $c$ is cost sensitivity.

## 2. Working policy

Higher-cognition passes are more justified when:

- the task is under-specified
- the cost of a wrong decision is high
- later correction is expensive

Lower-cognition or deterministic passes are more justified when:

- the artifact is already well-structured
- checks are mechanizable
- the main goal is consistency and throughput

An informal routing rule is:

$$
\operatorname{tier}(\tau) \uparrow \text{ as } a \uparrow, r \uparrow, m \downarrow
$$

## 3. Why this matters

Uniformly applying maximum cognition is wasteful. Uniformly applying minimum
cognition hides where stronger review should have happened.

The repo therefore treats cognition as a budget allocation problem, not a fixed
trait of the system.

## Claim dossier

- [CLM-016 cognitive tiering](../../reference/claims/dossiers/clm-016-cognitive-tiering.md)

## Interpretation limits

- tier boundaries are policy choices, not natural laws
- poor task routing can create failure even if the tiering doctrine is sound

## Source note

- [Kahneman](../../reference/claims/bibliography.md#src-kahneman-fast-slow)
- [Bainbridge automation](../../reference/claims/bibliography.md#src-bainbridge-automation)
- [Parasuraman and Riley](../../reference/claims/bibliography.md#src-parasuraman-riley)
- [Endsley situation awareness](../../reference/claims/bibliography.md#src-endsley-situation-awareness)
- [Amdahl 1967](../../reference/claims/bibliography.md#src-amdahl-1967)
- [Anthropic effective agents](../../reference/claims/bibliography.md#src-anthropic-effective-agents)
- [NIST GenAI Profile](../../reference/claims/bibliography.md#src-nist-genai-profile)
