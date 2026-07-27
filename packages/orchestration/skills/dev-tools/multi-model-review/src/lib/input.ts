/**
 * Validates multi-model review input strictly before it reaches file or scoring logic.
 */
import path from "node:path";
import { badInput } from "@coding-agents-space/shared";
import type { DriftMode, Input } from "../types.js";

const REVIEW_SEVERITIES = new Set(["critical", "high", "medium", "low", "info"]);
const DRIFT_VERIFICATION_STATUSES = new Set(["verified", "violated", "partial", "unverifiable"]);
const DRIFT_CLAIM_TYPES = new Set(["interface", "invariant", "security", "performance", "docs"]);

export function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function assertNoUnexpectedProperties(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
  context: string,
): void => {
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw badInput(`Unexpected property ${JSON.stringify(key)} in ${context}`);
    }
  }
};

export function validateExtractorClaimSets(claimSets: unknown): void {
  if (!Array.isArray(claimSets) || claimSets.length !== 2) throw badInput("drift_config.extractor_claim_sets must contain exactly 2 claim sets in dual-extractor mode");
  claimSets.forEach(validateExtractorClaimSet);
}

export function validateExtractorClaimSet(claimSet: unknown): void {
  if (!isObjectRecord(claimSet)) throw badInput("Each extractor_claim_set must be an object");
  assertNoUnexpectedProperties(claimSet, ["extractor", "claims"], "extractor_claim_set");
  assertNonEmptyString(claimSet.extractor, "Each extractor_claim_set requires a non-empty extractor string");
  if (!Array.isArray(claimSet.claims) || claimSet.claims.length === 0) throw badInput("Each extractor_claim_set requires a non-empty claims array");
  claimSet.claims.forEach(validateExtractorClaim);
}

export function validateExtractorClaim(claim: unknown): void {
  if (!isObjectRecord(claim)) throw badInput("Each extractor claim must be an object");
  assertNoUnexpectedProperties(claim, ["id", "claim", "claim_type", "verification_status", "evidence", "confidence"], "extractor claim");
  assertNonEmptyString(claim.id, "Each extractor claim must include a non-empty id");
  assertNonEmptyString(claim.claim, "Each extractor claim must include a non-empty claim");
  assertSetMember(claim.verification_status, DRIFT_VERIFICATION_STATUSES, "Each extractor claim verification_status must be one of: verified, violated, partial, unverifiable");
  assertOptionalSetMember(claim.claim_type, DRIFT_CLAIM_TYPES, "Each extractor claim claim_type must be one of: interface, invariant, security, performance, docs");
  assertNonEmptyString(claim.evidence, "Each extractor claim must include non-empty evidence");
  if (claim.confidence !== undefined && (typeof claim.confidence !== "number" || claim.confidence < 0 || claim.confidence > 1)) throw badInput("extractor claim confidence must be a number between 0 and 1");
}

export function assertNonEmptyString(value: unknown, message: string): void {
  if (typeof value !== "string" || value.length === 0) throw badInput(message);
}

export function assertSetMember(value: unknown, allowed: Set<string>, message: string): void {
  if (typeof value !== "string" || !allowed.has(value)) throw badInput(message);
}

export function assertOptionalSetMember(value: unknown, allowed: Set<string>, message: string): void {
  if (value !== undefined) assertSetMember(value, allowed, message);
}

export function validateReviewerFindings(reviewerFindings: unknown): void {
  if (!Array.isArray(reviewerFindings)) {
    throw badInput("reviewer_findings must be an array when provided");
  }
  if (reviewerFindings.length === 0) {
    throw badInput("reviewer_findings must be a non-empty array when provided");
  }

  reviewerFindings.forEach(validateReviewer);
}

export function validateReviewer(reviewer: unknown): void {
  if (!isObjectRecord(reviewer)) throw badInput("Each reviewer_findings entry must be an object");
  assertNoUnexpectedProperties(reviewer, ["reviewer_id", "role", "findings"], "reviewer_findings entry");
  assertNonEmptyString(reviewer.reviewer_id, "Each reviewer_findings entry requires reviewer_id");
  assertNonEmptyString(reviewer.role, "Each reviewer_findings entry requires role");
  if (!Array.isArray(reviewer.findings) || reviewer.findings.length === 0) throw badInput("Each reviewer_findings entry requires a non-empty findings array");
  reviewer.findings.forEach(validateReviewerFinding);
}

export function validateReviewerFinding(finding: unknown): void {
  if (!isObjectRecord(finding)) throw badInput("Each reviewer finding must be an object");
  assertNoUnexpectedProperties(finding, ["id", "category", "description", "severity", "evidence", "suggestion"], "reviewer finding");
  assertNonEmptyString(finding.id, "Each reviewer finding must include a non-empty id");
  assertNonEmptyString(finding.category, "Each reviewer finding must include a non-empty category");
  assertNonEmptyString(finding.description, "Each reviewer finding must include a non-empty description");
  assertSetMember(finding.severity, REVIEW_SEVERITIES, "Each reviewer finding severity must be one of: critical, high, medium, low, info");
  assertOptionalString(finding.evidence, "Each reviewer finding evidence must be a string when provided");
  assertOptionalString(finding.suggestion, "Each reviewer finding suggestion must be a string when provided");
}

export function assertOptionalString(value: unknown, message: string): void {
  if (value !== undefined && typeof value !== "string") throw badInput(message);
}

export function validateDriftConfig(
  driftConfig: unknown,
): { targetRef?: string; driftMode: DriftMode; hasExtractorClaimSets: boolean } | undefined {
  if (driftConfig === undefined) return undefined;
  if (!isObjectRecord(driftConfig)) {
    throw badInput("drift_config must be an object when provided");
  }
  assertNoUnexpectedProperties(
    driftConfig,
    ["source_ref", "target_ref", "mode", "extractor_claim_sets"],
    "drift_config",
  );

  assertOptionalString(driftConfig.source_ref, "drift_config.source_ref must be a string when provided");
  const targetRef = validateTargetRef(driftConfig.target_ref);
  const driftMode = validateDriftMode(driftConfig.mode);
  const extractorClaims = driftConfig.extractor_claim_sets;
  if (extractorClaims !== undefined) validateExtractorClaimSets(extractorClaims);
  return { targetRef, driftMode, hasExtractorClaimSets: extractorClaims !== undefined };
}

export function validateTargetRef(targetRef: unknown): string | undefined {
  if (targetRef === undefined) return undefined;
  if (typeof targetRef !== "string") throw badInput("drift_config.target_ref must be a string when provided");
  if (targetRef.length > 0 && path.isAbsolute(targetRef)) throw badInput("drift_config.target_ref must resolve within workspaceRoot");
  return targetRef;
}

export function validateDriftMode(value: unknown): DriftMode {
  if (value === undefined) return "heuristic";
  if (value === "heuristic" || value === "dual-extractor") return value;
  throw badInput("drift_config.mode must be 'heuristic' or 'dual-extractor'");
}

/**
 * Validates the complete review request before file reads, scoring, or model-result aggregation occur.
 */
export function validateInput(input: Input): void {
  if (!isObjectRecord(input)) {
    throw badInput("input must be a JSON object");
  }
  assertNoUnexpectedProperties(
    input as Record<string, unknown>,
    ["action", "document", "reviewer_findings", "drift_config"],
    "input",
  );

  validateAction(input.action);
  validateDocument(input.document);
  if (input.reviewer_findings !== undefined) validateReviewerFindings(input.reviewer_findings);
  const validatedDriftConfig = validateDriftConfig(input.drift_config);
  validateActionRequirements(input, validatedDriftConfig);
}

export function validateAction(action: unknown): void {
  if (!isObjectRecord(action)) throw badInput("action must be an object");
  assertNoUnexpectedProperties(action, ["type"], "action");
  if (action.type !== "review" && action.type !== "drift-detect") throw badInput("action.type must be 'review' or 'drift-detect'");
}

export function validateDocument(document: unknown): void {
  if (!isObjectRecord(document)) throw badInput("document must be an object");
  assertNoUnexpectedProperties(document, ["content", "type"], "document");
  assertNonEmptyString(document.content, "document.content is required");
  if (document.type !== "design" && document.type !== "plan" && document.type !== "implementation") throw badInput("document.type must be design, plan, or implementation");
}

export function validateActionRequirements(input: Input, driftConfig: ReturnType<typeof validateDriftConfig>): void {
  if (input.action.type === "review") {
    if (input.reviewer_findings === undefined) throw badInput("reviewer_findings must be a non-empty array for review action");
    return;
  }
  if (!driftConfig?.targetRef) throw badInput("drift_config.target_ref is required for drift-detect action");
  if (driftConfig.driftMode === "dual-extractor" && !driftConfig.hasExtractorClaimSets) throw badInput("drift_config.extractor_claim_sets must contain exactly 2 claim sets in dual-extractor mode");
  if (input.document.type !== "design" && input.document.type !== "plan") throw badInput("drift-detect requires document.type to be design or plan");
}
