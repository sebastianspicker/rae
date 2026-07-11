export interface Section {
  heading: string;
  body: string;
  synthetic?: boolean;
}

export function parseSections(text: string): Section[] {
  const sections: Section[] = [];
  let current: Section | null = null;
  const preambleLines: string[] = [];
  for (const line of text.split("\n")) {
    const match = line.match(/^#{1,6}\s+(.+)/);
    if (match?.[1]) {
      if (current) sections.push(current);
      current = { heading: match[1].trim(), body: "" };
    } else if (current) current.body += `${line}\n`;
    else preambleLines.push(line);
  }
  if (current) sections.push(current);
  const preamble = preambleLines.join("\n").trim();
  if (preamble)
    sections.unshift({
      heading: sections.length ? "Preamble" : "Document",
      body: preamble,
      synthetic: true,
    });
  return sections;
}

export function extractAssertions(body: string): string[] {
  return body
    .split("\n")
    .map((line) => line.trim())
    .filter((line) =>
      /^(?:[-*•]\s+|\d+[.)]\s+)|\b(must|shall|should|requires?|constraint|ensures?|guarantees?|limit)\b/i.test(
        line,
      ),
    )
    .map((line) => line.replace(/^[-*•\d.)]+\s*/, "").trim())
    .filter((line) => line.length > 5);
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
  )
    return "security";
  if (
    /\b(latency|throughput|cache|performance|memory|cpu|scale|rate limit|qps|timeout)\b/.test(text)
  )
    return "performance";
  if (/\b(readme|docs|documentation|changelog|guide|example)\b/.test(text)) return "docs";
  if (/\b(api|endpoint|route|schema|contract|interface|payload|request|response)\b/.test(text))
    return "interface";
  return "invariant";
}

export function toDriftScore(status: DriftVerificationStatus): number {
  return status === "verified" ? 0 : status === "partial" ? 0.5 : status === "violated" ? 1 : 0.75;
}

export function claimMatchScore(claim: string, target: string): number {
  const words = normalize(claim)
    .split(" ")
    .filter((word) => word.length > 2);
  if (!words.length) return -1;
  const normalizedTarget = normalize(target);
  return words.filter((word) => normalizedTarget.includes(word)).length / words.length;
}

export function toVerificationStatus(score: number): DriftVerificationStatus {
  return score < 0
    ? "unverifiable"
    : score >= 0.6
      ? "verified"
      : score >= 0.35
        ? "partial"
        : "violated";
}

export function findingSeverity(status: DriftVerificationStatus): DriftFinding["severity"] {
  return status === "violated"
    ? "high"
    : status === "partial" || status === "unverifiable"
      ? "medium"
      : "low";
}

export function buildFindingsFromClaims(claims: DriftClaim[]): DriftFinding[] {
  return claims
    .filter((claim) => claim.verification_status !== "verified")
    .map((claim) => ({
      description: `Claim is ${claim.verification_status}: "${claim.claim}"`,
      claim_type: claim.claim_type,
      severity: findingSeverity(claim.verification_status),
      claim_ids: [claim.id],
      mitigation:
        "Verify this requirement is addressed in the target artifact and update implementation or plan accordingly.",
    }));
}
import type {
  DriftClaim,
  DriftClaimType,
  DriftFinding,
  DriftVerificationStatus,
} from "../types.js";
