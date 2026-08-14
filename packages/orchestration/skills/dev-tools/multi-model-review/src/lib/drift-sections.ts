/** Parses structured review sections for deterministic drift analysis. */
import type {
  DriftClaim,
  DriftClaimType,
  DriftFinding,
  DriftVerificationStatus,
} from "../types.js";

export interface Section {
  heading: string;
  body: string;
  synthetic?: boolean;
}

function markdownHeading(line: string): string | undefined {
  const heading = line.match(/^#{1,6}\s+(.+)/)?.[1];
  return heading === undefined ? undefined : heading.trim();
}

function appendSection(
  sections: Section[],
  heading: string | undefined,
  bodyLines: string[],
): void {
  if (heading === undefined) return;
  sections.push({
    heading,
    body: bodyLines.length > 0 ? `${bodyLines.join("\n")}\n` : "",
  });
}

function prependPreamble(sections: Section[], preambleLines: string[]): void {
  const preamble = preambleLines.join("\n").trim();
  if (preamble.length === 0) return;
  sections.unshift({
    heading: sections.length > 0 ? "Preamble" : "Document",
    body: preamble,
    synthetic: true,
  });
}

/**
 * Splits a document into sections by markdown-style headings.
 * Lines starting with # are section boundaries.
 */
export function parseSections(text: string): Section[] {
  const sections: Section[] = [];
  let currentHeading: string | undefined;
  let currentBodyLines: string[] = [];
  const preambleLines: string[] = [];

  for (const line of text.split("\n")) {
    const heading = markdownHeading(line);
    if (heading !== undefined) {
      appendSection(sections, currentHeading, currentBodyLines);
      currentHeading = heading;
      currentBodyLines = [];
      continue;
    }
    if (currentHeading === undefined) {
      preambleLines.push(line);
      continue;
    }
    currentBodyLines.push(line);
  }
  appendSection(sections, currentHeading, currentBodyLines);
  prependPreamble(sections, preambleLines);

  return sections;
}

export function extractNormalizedHeadings(text: string): Set<string> {
  const headings = new Set<string>();
  for (const line of text.split("\n")) {
    const heading = markdownHeading(line);
    if (heading !== undefined) headings.add(normalize(heading));
  }
  return headings;
}

/**
 * Extracts key assertions from a section body.
 * Looks for: bullet points, bold text, constraint keywords.
 */
export function extractAssertions(body: string): string[] {
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

export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function classifyClaimType(claim: string): DriftClaimType {
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

export function toDriftScore(status: DriftVerificationStatus): number {
  if (status === "verified") return 0;
  if (status === "partial") return 0.5;
  if (status === "violated") return 1;
  return 0.75;
}

/**
 * Calculates significant keyword overlap score between claim and target.
 */
export function claimMatchScore(claim: string, targetText: string): number {
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

export function toVerificationStatus(score: number): DriftVerificationStatus {
  if (score < 0) return "unverifiable";
  if (score >= 0.6) return "verified";
  if (score >= 0.35) return "partial";
  return "violated";
}

export function findingSeverity(status: DriftVerificationStatus): DriftFinding["severity"] {
  if (status === "violated") return "high";
  if (status === "partial" || status === "unverifiable") return "medium";
  return "low";
}

export function buildFindingsFromClaims(claims: DriftClaim[]): DriftFinding[] {
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
