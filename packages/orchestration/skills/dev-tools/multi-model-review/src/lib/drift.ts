import type {
  DriftAdjudication,
  DriftClaim,
  DriftClaimType,
  DriftFinding,
  DriftVerificationStatus,
  ExtractorClaimInput,
  ExtractorClaimSet,
} from "../types.js";
import { tokenSimilarity } from "./dedup.js";
import {
  buildFindingsFromClaims,
  claimMatchScore,
  classifyClaimType,
  extractAssertions,
  findingSeverity,
  normalize,
  parseSections,
  toDriftScore,
  toVerificationStatus,
} from "./drift-sections.js";
import { extractNormalizedHeadings } from "./drift-headings.js";

export interface DriftDetectionResult {
  claims: DriftClaim[];
  findings: DriftFinding[];
  adjudication: DriftAdjudication;
}

interface CorrelationPair {
  first: ExtractorClaimInput;
  second?: ExtractorClaimInput;
}

const TAXONOMY: DriftClaimType[] = ["interface", "invariant", "security", "performance", "docs"];

function correlateClaims(
  first: ExtractorClaimSet,
  second: ExtractorClaimSet,
): { pairs: CorrelationPair[]; unmatchedSecond: ExtractorClaimInput[] } {
  const pairs: CorrelationPair[] = [];
  const usedSecond = new Set<number>();
  const minSimilarity = 0.55;

  for (const left of first.claims) {
    let bestIdx = -1;
    let bestScore = 0;
    for (let idx = 0; idx < second.claims.length; idx++) {
      if (usedSecond.has(idx)) continue;
      const right = second.claims[idx];
      if (!right) continue;
      const score = left.id === right.id ? 1 : tokenSimilarity(left.claim, right.claim);
      if (score > bestScore) {
        bestScore = score;
        bestIdx = idx;
      }
    }
    if (bestIdx >= 0 && bestScore >= minSimilarity) {
      usedSecond.add(bestIdx);
      pairs.push({ first: left, second: second.claims[bestIdx] });
      continue;
    }
    pairs.push({ first: left });
  }

  const unmatchedSecond = second.claims.filter((_, idx) => !usedSecond.has(idx));
  return { pairs, unmatchedSecond };
}

const mergeConfidence = (first?: number, second?: number): number | undefined => {
  const hasFirst = typeof first === "number";
  const hasSecond = typeof second === "number";
  if (hasFirst && hasSecond) {
    return Number(((first + second) / 2).toFixed(4));
  }
  if (hasFirst) return first;
  if (hasSecond) return second;
  return undefined;
};

function adjudicatePair(
  firstStatus: DriftVerificationStatus,
  secondStatus?: DriftVerificationStatus,
): { status: DriftVerificationStatus; conflict: boolean } {
  if (!secondStatus) return { status: "unverifiable", conflict: false };
  const pair = new Set([firstStatus, secondStatus]);
  if (pair.has("verified") && pair.has("violated")) return { status: "partial", conflict: true };
  if (pair.size === 1 && pair.has("verified")) return { status: "verified", conflict: false };
  if (pair.has("violated")) return { status: "violated", conflict: false };
  return {
    status: pair.has("verified") || pair.has("partial") ? "partial" : "unverifiable",
    conflict: false,
  };
}

export function detectDrift(sourceText: string, targetText: string): DriftDetectionResult {
  const sourceSections = parseSections(sourceText);
  const targetHeadings = extractNormalizedHeadings(targetText);
  const claims: DriftClaim[] = [];
  const findings: DriftFinding[] = [];
  let claimIdx = 0;

  for (const section of sourceSections)
    claimIdx = appendSectionDrift(section, targetText, targetHeadings, claims, findings, claimIdx);

  return {
    claims,
    findings,
    adjudication: {
      mode: "heuristic",
      extractors: ["rule-based-drift-detector"],
      conflicts_resolved: 0,
      resolution_policy: "Keyword-overlap heuristic with deterministic status mapping thresholds.",
    },
  };
}

function appendSectionDrift(
  section: { heading: string; body: string; synthetic?: boolean },
  targetText: string,
  headings: Set<string>,
  claims: DriftClaim[],
  findings: DriftFinding[],
  index: number,
): number {
  const assertions = extractAssertions(section.body);
  if (!assertions.length) return appendSectionPresence(section, headings, claims, findings, index);
  for (const assertion of assertions)
    index = appendAssertion(section.heading, assertion, targetText, claims, findings, index);
  return index;
}

function appendSectionPresence(
  section: { heading: string; synthetic?: boolean },
  headings: Set<string>,
  claims: DriftClaim[],
  findings: DriftFinding[],
  index: number,
): number {
  if (section.synthetic) return index;
  const present = headings.has(normalize(section.heading));
  const id = `drift-${index + 1}`;
  const status: DriftVerificationStatus = present ? "verified" : "violated";
  const claim = `Section "${section.heading}" should be present`;
  claims.push({
    id,
    claim,
    claim_type: classifyClaimType(claim),
    verification_status: status,
    evidence: present
      ? `Found section heading "${section.heading}" in target document`
      : `Source has heading "${section.heading}" but target does not`,
    extractor: "rule-based-drift-detector",
    drift_score: toDriftScore(status),
  });
  if (!present)
    findings.push({
      description: `Section "${section.heading}" from source is missing in target`,
      severity: "medium",
      claim_ids: [id],
      mitigation: `Add or address the "${section.heading}" section in the target document`,
    });
  return index + 1;
}

function appendAssertion(
  heading: string,
  assertion: string,
  target: string,
  claims: DriftClaim[],
  findings: DriftFinding[],
  index: number,
): number {
  const id = `drift-${index + 1}`;
  const score = claimMatchScore(assertion, target);
  const status = toVerificationStatus(score);
  appendAssertionClaim(claims, id, assertion, heading, score, status);
  appendAssertionFinding(findings, id, assertion, heading, status);
  return index + 1;
}

function appendAssertionClaim(
  claims: DriftClaim[],
  id: string,
  assertion: string,
  heading: string,
  score: number,
  status: DriftVerificationStatus,
): void {
  claims.push({
    id,
    claim: assertion,
    claim_type: classifyClaimType(assertion),
    verification_status: status,
    evidence: assertionEvidence(status, heading, score),
    extractor: "rule-based-drift-detector",
    drift_score: toDriftScore(status),
  });
}

function assertionEvidence(
  status: DriftVerificationStatus,
  heading: string,
  score: number,
): string {
  if (status === "verified")
    return `Strong keyword overlap (${Math.round(score * 100)}%) in target`;
  const overlap = score < 0 ? "n/a" : `${Math.round(score * 100)}%`;
  return `Claim from source section "${heading}" not fully reflected in target (overlap: ${overlap})`;
}

function appendAssertionFinding(
  findings: DriftFinding[],
  id: string,
  assertion: string,
  heading: string,
  status: DriftVerificationStatus,
): void {
  if (status !== "verified")
    findings.push({
      description: `Assertion from "${heading}" is ${status}: "${assertion}"`,
      claim_type: classifyClaimType(assertion),
      severity: findingSeverity(status),
      claim_ids: [id],
      mitigation:
        "Verify this requirement is addressed in the target artifact and update implementation or plan accordingly.",
    });
}

export function detectDriftFromExtractorClaims(
  extractorClaimSets: ExtractorClaimSet[],
): DriftDetectionResult {
  const [first, second] = extractorClaimSets;
  if (extractorClaimSets.length !== 2 || !first || !second) {
    throw Object.assign(new Error("dual-extractor mode requires exactly 2 extractor_claim_sets"), {
      code: "E_BAD_INPUT",
    });
  }
  const { pairs, unmatchedSecond } = correlateClaims(first, second);
  const claims: DriftClaim[] = [];
  let conflictsResolved = 0;
  let claimIdx = 0;

  for (const pair of pairs) {
    const result = appendAdjudicatedClaim(
      claims,
      pair,
      first.extractor,
      second.extractor,
      claimIdx,
    );
    claimIdx = result.claimIdx;
    conflictsResolved += result.conflict;
  }

  for (const claim of unmatchedSecond) {
    claims.push({
      id: `drift-${++claimIdx}`,
      claim: claim.claim,
      claim_type: claim.claim_type ?? classifyClaimType(claim.claim),
      verification_status: "unverifiable",
      evidence: `${second.extractor}: ${claim.verification_status} (${claim.evidence}); no corresponding claim from ${first.extractor}`,
      extractor: `dual-adjudicator:${first.extractor}+${second.extractor}`,
      drift_score: toDriftScore("unverifiable"),
      confidence: claim.confidence,
    });
  }

  return {
    claims,
    findings: buildFindingsFromClaims(claims),
    adjudication: {
      mode: "dual-extractor",
      extractors: [first.extractor, second.extractor],
      conflicts_resolved: conflictsResolved,
      resolution_policy:
        "both verified => verified; any violated without verified => violated; verified+violated => partial; missing counterpart => unverifiable",
    },
  };
}

function appendAdjudicatedClaim(
  claims: DriftClaim[],
  pair: CorrelationPair,
  firstExtractor: string,
  secondExtractor: string,
  claimIdx: number,
): { claimIdx: number; conflict: number } {
  const adjudicated = adjudicatePair(
    pair.first.verification_status,
    pair.second?.verification_status,
  );
  const claimText =
    pair.second && pair.second.claim.length > pair.first.claim.length
      ? pair.second.claim
      : pair.first.claim;
  claims.push({
    id: `drift-${claimIdx + 1}`,
    claim: claimText,
    claim_type: pair.first.claim_type ?? pair.second?.claim_type ?? classifyClaimType(claimText),
    verification_status: adjudicated.status,
    evidence: pair.second
      ? `${firstExtractor}: ${pair.first.verification_status} (${pair.first.evidence}) | ${secondExtractor}: ${pair.second.verification_status} (${pair.second.evidence})`
      : `${firstExtractor}: ${pair.first.verification_status} (${pair.first.evidence}); no corresponding claim from ${secondExtractor}`,
    extractor: `dual-adjudicator:${firstExtractor}+${secondExtractor}`,
    drift_score: toDriftScore(adjudicated.status),
    confidence: mergeConfidence(pair.first.confidence, pair.second?.confidence),
  });
  return { claimIdx: claimIdx + 1, conflict: Number(adjudicated.conflict) };
}

export interface DriftQualityClassMetrics {
  precision: number;
  recall: number;
  f1: number;
}

export interface DriftQualityMetrics {
  overall: DriftQualityClassMetrics;
  by_class: Record<DriftClaimType, DriftQualityClassMetrics>;
}

function toMetrics(tp: number, fp: number, fn: number): DriftQualityClassMetrics {
  const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { precision, recall, f1 };
}

export function evaluateDriftQuality(
  expected: DriftClaimType[],
  predicted: DriftClaimType[],
): DriftQualityMetrics {
  const byClass = {} as Record<DriftClaimType, DriftQualityClassMetrics>;

  let totalTp = 0;
  let totalFp = 0;
  let totalFn = 0;

  for (const taxonomyClass of TAXONOMY) {
    const expectedCount = expected.filter((entry) => entry === taxonomyClass).length;
    const predictedCount = predicted.filter((entry) => entry === taxonomyClass).length;
    const tp = Math.min(expectedCount, predictedCount);
    const fp = Math.max(0, predictedCount - expectedCount);
    const fn = Math.max(0, expectedCount - predictedCount);

    totalTp += tp;
    totalFp += fp;
    totalFn += fn;
    byClass[taxonomyClass] = toMetrics(tp, fp, fn);
  }

  return {
    overall: toMetrics(totalTp, totalFp, totalFn),
    by_class: byClass,
  };
}
