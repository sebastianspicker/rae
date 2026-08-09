/**
 * Extracts and adjudicates design-to-implementation drift claims for review evidence.
 */
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
  extractNormalizedHeadings,
  findingSeverity,
  normalize,
  parseSections,
  toDriftScore,
  toVerificationStatus,
} from "./drift-sections.js";

export {
  buildFindingsFromClaims,
  claimMatchScore,
  classifyClaimType,
  extractAssertions,
  extractNormalizedHeadings,
  findingSeverity,
  normalize,
  parseSections,
  toDriftScore,
  toVerificationStatus,
} from "./drift-sections.js";

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

export function correlateClaims(
  first: ExtractorClaimSet,
  second: ExtractorClaimSet,
): { pairs: CorrelationPair[]; unmatchedSecond: ExtractorClaimInput[] } {
  const pairs: CorrelationPair[] = [];
  const usedSecond = new Set<number>();

  for (const left of first.claims) {
    const best = findBestClaimMatch(left, second.claims, usedSecond);
    if (best) {
      usedSecond.add(best.index);
      pairs.push({ first: left, second: best.claim });
      continue;
    }
    pairs.push({ first: left });
  }

  const unmatchedSecond = second.claims.filter((_, idx) => !usedSecond.has(idx));
  return { pairs, unmatchedSecond };
}

export function findBestClaimMatch(
  left: ExtractorClaimInput,
  candidates: ExtractorClaimInput[],
  used: Set<number>,
): { index: number; claim: ExtractorClaimInput } | undefined {
  let best: { index: number; claim: ExtractorClaimInput; score: number } | undefined;
  candidates.forEach((candidate, index) => {
    if (used.has(index)) return;
    const score = claimSimilarity(left, candidate);
    if (!best || score > best.score) best = { index, claim: candidate, score };
  });
  return best && best.score >= 0.55 ? { index: best.index, claim: best.claim } : undefined;
}

export function claimSimilarity(left: ExtractorClaimInput, right: ExtractorClaimInput): number {
  return left.id === right.id ? 1 : tokenSimilarity(left.claim, right.claim);
}

export function mergeConfidence(first?: number, second?: number): number | undefined {
  const hasFirst = typeof first === "number";
  const hasSecond = typeof second === "number";
  if (hasFirst && hasSecond) {
    return Number(((first + second) / 2).toFixed(4));
  }
  if (hasFirst) return first;
  if (hasSecond) return second;
  return undefined;
}

export function adjudicatePair(
  firstStatus: DriftVerificationStatus,
  secondStatus?: DriftVerificationStatus,
): { status: DriftVerificationStatus; conflict: boolean } {
  if (!secondStatus) return { status: "unverifiable", conflict: false };
  const statuses = new Set([firstStatus, secondStatus]);
  return adjudicateStatuses(statuses);
}

export function adjudicateStatuses(statuses: Set<DriftVerificationStatus>): {
  status: DriftVerificationStatus;
  conflict: boolean;
} {
  return {
    status: resolvedAdjudicationStatus(statuses),
    conflict: statuses.has("verified") && statuses.has("violated"),
  };
}

function resolvedAdjudicationStatus(
  statuses: Set<DriftVerificationStatus>,
): DriftVerificationStatus {
  if (statuses.has("verified")) {
    return statuses.size === 1 ? "verified" : "partial";
  }
  if (statuses.has("violated")) return "violated";
  return statuses.has("partial") ? "partial" : "unverifiable";
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
  validateExtractorClaimSets(extractorClaimSets, first, second);
  if (!first || !second)
    throw new Error("dual-extractor mode requires exactly 2 extractor_claim_sets");
  const { pairs, unmatchedSecond } = correlateClaims(first, second);
  const correlated = buildCorrelatedClaims(pairs, first, second);
  const claims = [
    ...correlated.claims,
    ...buildUnmatchedClaims(unmatchedSecond, first, second, correlated.claims.length),
  ];
  return buildDualExtractorResult(claims, first, second, correlated.conflictsResolved);
}

function validateExtractorClaimSets(
  claimSets: ExtractorClaimSet[],
  first?: ExtractorClaimSet,
  second?: ExtractorClaimSet,
): asserts first is ExtractorClaimSet & NonNullable<typeof second> {
  if (claimSets.length === 2 && first && second) return;
  throw Object.assign(new Error("dual-extractor mode requires exactly 2 extractor_claim_sets"), {
    code: "E_BAD_INPUT",
  });
}

function buildCorrelatedClaims(
  pairs: CorrelationPair[],
  first: ExtractorClaimSet,
  second: ExtractorClaimSet,
): { claims: DriftClaim[]; conflictsResolved: number } {
  const claims: DriftClaim[] = [];
  let conflictsResolved = 0;
  for (const pair of pairs) {
    const adjudicated = adjudicatePair(
      pair.first.verification_status,
      pair.second?.verification_status,
    );
    if (adjudicated.conflict) {
      conflictsResolved++;
    }

    claims.push(buildCorrelatedClaim(pair, adjudicated.status, first, second, claims.length + 1));
  }
  return { claims, conflictsResolved };
}

function buildCorrelatedClaim(
  pair: CorrelationPair,
  status: DriftVerificationStatus,
  first: ExtractorClaimSet,
  second: ExtractorClaimSet,
  index: number,
): DriftClaim {
  const claimText =
    !pair.second || pair.first.claim.length >= pair.second.claim.length
      ? pair.first.claim
      : pair.second.claim;
  return {
    id: `drift-${index}`,
    claim: claimText,
    claim_type: pair.first.claim_type ?? pair.second?.claim_type ?? classifyClaimType(claimText),
    verification_status: status,
    evidence: pair.second
      ? `${first.extractor}: ${pair.first.verification_status} (${pair.first.evidence}) | ${second.extractor}: ${pair.second.verification_status} (${pair.second.evidence})`
      : `${first.extractor}: ${pair.first.verification_status} (${pair.first.evidence}); no corresponding claim from ${second.extractor}`,
    extractor: `dual-adjudicator:${first.extractor}+${second.extractor}`,
    drift_score: toDriftScore(status),
    confidence: mergeConfidence(pair.first.confidence, pair.second?.confidence),
  };
}

function buildUnmatchedClaims(
  unmatched: ExtractorClaimInput[],
  first: ExtractorClaimSet,
  second: ExtractorClaimSet,
  start: number,
): DriftClaim[] {
  return unmatched.map((claim, offset) => ({
    id: `drift-${start + offset + 1}`,
    claim: claim.claim,
    claim_type: claim.claim_type ?? classifyClaimType(claim.claim),
    verification_status: "unverifiable",
    evidence: `${second.extractor}: ${claim.verification_status} (${claim.evidence}); no corresponding claim from ${first.extractor}`,
    extractor: `dual-adjudicator:${first.extractor}+${second.extractor}`,
    drift_score: toDriftScore("unverifiable"),
    confidence: claim.confidence,
  }));
}

function buildDualExtractorResult(
  claims: DriftClaim[],
  first: ExtractorClaimSet,
  second: ExtractorClaimSet,
  conflictsResolved: number,
): DriftDetectionResult {
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

export interface DriftQualityClassMetrics {
  precision: number;
  recall: number;
  f1: number;
}

export interface DriftQualityMetrics {
  overall: DriftQualityClassMetrics;
  by_class: Record<DriftClaimType, DriftQualityClassMetrics>;
}

export function toMetrics(tp: number, fp: number, fn: number): DriftQualityClassMetrics {
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
