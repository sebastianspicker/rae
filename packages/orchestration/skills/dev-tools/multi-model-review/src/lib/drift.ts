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

interface Section {
  heading: string;
  body: string;
  synthetic?: boolean;
}

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

/**
 * Splits a document into sections by markdown-style headings.
 * Lines starting with # are section boundaries.
 */
function parseSections(text: string): Section[] {
  const lines = text.split("\n");
  const sections: Section[] = [];
  let current: Section | null = null;
  const preambleLines: string[] = [];

  for (const line of lines) {
    const headingMatch = line.match(/^#{1,6}\s+(.+)/);
    if (headingMatch) {
      const heading = headingMatch[1];
      if (!heading) continue;
      if (current) sections.push(current);
      current = { heading: heading.trim(), body: "" };
    } else if (current) {
      current.body += `${line}\n`;
    } else {
      preambleLines.push(line);
    }
  }
  if (current) sections.push(current);

  const preamble = preambleLines.join("\n").trim();
  if (preamble.length > 0) {
    sections.unshift({
      heading: sections.length > 0 ? "Preamble" : "Document",
      body: preamble,
      synthetic: true,
    });
  }

  return sections;
}

function extractNormalizedHeadings(text: string): Set<string> {
  const headings = new Set<string>();
  for (const line of text.split("\n")) {
    const headingMatch = line.match(/^#{1,6}\s+(.+)/);
    if (!headingMatch) continue;
    const heading = headingMatch[1];
    if (!heading) continue;
    headings.add(normalize(heading.trim()));
  }
  return headings;
}

/**
 * Extracts key assertions from a section body.
 * Looks for: bullet points, bold text, constraint keywords.
 */
function extractAssertions(body: string): string[] {
  const assertions: string[] = [];
  const lines = body.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const isBullet = /^[-*•]\s+/.test(trimmed);
    const isNumbered = /^\d+[.)]\s+/.test(trimmed);
    const hasKeyword =
      /\b(must|shall|should|requires?|constraint|ensures?|guarantees?|limit)\b/i.test(trimmed);

    if (isBullet || isNumbered || hasKeyword) {
      assertions.push(trimmed.replace(/^[-*•\d.)]+\s*/, "").trim());
    }
  }

  return assertions.filter((a) => a.length > 5);
}

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function classifyClaimType(claim: string): DriftClaimType {
  const text = normalize(claim);
  if (
    /\b(auth|jwt|csrf|xss|secret|encryption|token|permission|rbac|owasp|vulnerability|security)\b/.test(
      text,
    )
  ) {
    return "security";
  }
  if (
    /\b(latency|throughput|cache|performance|memory|cpu|scale|rate limit|qps|timeout)\b/.test(text)
  ) {
    return "performance";
  }
  if (/\b(readme|docs|documentation|changelog|guide|example)\b/.test(text)) {
    return "docs";
  }
  if (/\b(api|endpoint|route|schema|contract|interface|payload|request|response)\b/.test(text)) {
    return "interface";
  }
  return "invariant";
}

function toDriftScore(status: DriftVerificationStatus): number {
  if (status === "verified") return 0;
  if (status === "partial") return 0.5;
  if (status === "violated") return 1;
  return 0.75;
}

/**
 * Calculates significant keyword overlap score between claim and target.
 */
function claimMatchScore(claim: string, targetText: string): number {
  const claimWords = normalize(claim)
    .split(" ")
    .filter((w) => w.length > 2);
  if (claimWords.length === 0) return -1;

  const targetNorm = normalize(targetText);
  let hits = 0;
  for (const w of claimWords) {
    if (targetNorm.includes(w)) hits++;
  }
  return hits / claimWords.length;
}

function toVerificationStatus(score: number): DriftVerificationStatus {
  if (score < 0) return "unverifiable";
  if (score >= 0.6) return "verified";
  if (score >= 0.35) return "partial";
  return "violated";
}

function findingSeverity(status: DriftVerificationStatus): DriftFinding["severity"] {
  if (status === "violated") return "high";
  if (status === "partial" || status === "unverifiable") return "medium";
  return "low";
}

function buildFindingsFromClaims(claims: DriftClaim[]): DriftFinding[] {
  const findings: DriftFinding[] = [];
  for (const claim of claims) {
    if (claim.verification_status === "verified") continue;
    findings.push({
      description: `Claim is ${claim.verification_status}: "${claim.claim}"`,
      claim_type: claim.claim_type,
      severity: findingSeverity(claim.verification_status),
      claim_ids: [claim.id],
      mitigation:
        "Verify this requirement is addressed in the target artifact and update implementation or plan accordingly.",
    });
  }
  return findings;
}

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

function mergeConfidence(first?: number, second?: number): number | undefined {
  const hasFirst = typeof first === "number";
  const hasSecond = typeof second === "number";
  if (hasFirst && hasSecond) {
    return Number(((first + second) / 2).toFixed(4));
  }
  if (hasFirst) return first;
  if (hasSecond) return second;
  return undefined;
}

function adjudicatePair(
  firstStatus: DriftVerificationStatus,
  secondStatus?: DriftVerificationStatus,
): { status: DriftVerificationStatus; conflict: boolean } {
  if (!secondStatus) {
    return { status: "unverifiable", conflict: false };
  }

  const hasVerified = firstStatus === "verified" || secondStatus === "verified";
  const hasViolated = firstStatus === "violated" || secondStatus === "violated";
  if (hasVerified && hasViolated) {
    return { status: "partial", conflict: true };
  }
  if (firstStatus === "verified" && secondStatus === "verified") {
    return { status: "verified", conflict: false };
  }
  if (hasViolated && !hasVerified) {
    return { status: "violated", conflict: false };
  }
  if (hasVerified) {
    return { status: "partial", conflict: false };
  }
  if (firstStatus === "partial" || secondStatus === "partial") {
    return { status: "partial", conflict: false };
  }
  return { status: "unverifiable", conflict: false };
}

export function detectDrift(sourceText: string, targetText: string): DriftDetectionResult {
  const sourceSections = parseSections(sourceText);
  const targetHeadings = extractNormalizedHeadings(targetText);
  const claims: DriftClaim[] = [];
  const findings: DriftFinding[] = [];
  let claimIdx = 0;

  for (const section of sourceSections) {
    const assertions = extractAssertions(section.body);

    if (assertions.length === 0) {
      if (section.synthetic) {
        continue;
      }
      const sectionPresent = targetHeadings.has(normalize(section.heading));
      const id = `drift-${++claimIdx}`;
      const claimText = `Section "${section.heading}" should be present`;
      const verificationStatus: DriftVerificationStatus = sectionPresent ? "verified" : "violated";
      claims.push({
        id,
        claim: claimText,
        claim_type: classifyClaimType(claimText),
        verification_status: verificationStatus,
        evidence: sectionPresent
          ? `Found section heading "${section.heading}" in target document`
          : `Source has heading "${section.heading}" but target does not`,
        extractor: "rule-based-drift-detector",
        drift_score: toDriftScore(verificationStatus),
      });
      if (!sectionPresent) {
        findings.push({
          description: `Section "${section.heading}" from source is missing in target`,
          severity: "medium",
          claim_ids: [id],
          mitigation: `Add or address the "${section.heading}" section in the target document`,
        });
      }
      continue;
    }

    for (const assertion of assertions) {
      const id = `drift-${++claimIdx}`;
      const score = claimMatchScore(assertion, targetText);
      const verificationStatus = toVerificationStatus(score);

      claims.push({
        id,
        claim: assertion,
        claim_type: classifyClaimType(assertion),
        verification_status: verificationStatus,
        evidence:
          verificationStatus === "verified"
            ? `Strong keyword overlap (${Math.round(score * 100)}%) in target`
            : `Claim from source section "${section.heading}" not fully reflected in target (overlap: ${score < 0 ? "n/a" : `${Math.round(score * 100)}%`})`,
        extractor: "rule-based-drift-detector",
        drift_score: toDriftScore(verificationStatus),
      });

      if (verificationStatus !== "verified") {
        findings.push({
          description: `Assertion from "${section.heading}" is ${verificationStatus}: "${assertion}"`,
          claim_type: classifyClaimType(assertion),
          severity: findingSeverity(verificationStatus),
          claim_ids: [id],
          mitigation:
            "Verify this requirement is addressed in the target artifact and update implementation or plan accordingly.",
        });
      }
    }
  }

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
    const adjudicated = adjudicatePair(
      pair.first.verification_status,
      pair.second?.verification_status,
    );
    if (adjudicated.conflict) {
      conflictsResolved++;
    }

    const claimText = pair.second
      ? pair.first.claim.length >= pair.second.claim.length
        ? pair.first.claim
        : pair.second.claim
      : pair.first.claim;
    const confidence = mergeConfidence(pair.first.confidence, pair.second?.confidence);
    claims.push({
      id: `drift-${++claimIdx}`,
      claim: claimText,
      claim_type: pair.first.claim_type ?? pair.second?.claim_type ?? classifyClaimType(claimText),
      verification_status: adjudicated.status,
      evidence: pair.second
        ? `${first.extractor}: ${pair.first.verification_status} (${pair.first.evidence}) | ${second.extractor}: ${pair.second.verification_status} (${pair.second.evidence})`
        : `${first.extractor}: ${pair.first.verification_status} (${pair.first.evidence}); no corresponding claim from ${second.extractor}`,
      extractor: `dual-adjudicator:${first.extractor}+${second.extractor}`,
      drift_score: toDriftScore(adjudicated.status),
      confidence,
    });
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
