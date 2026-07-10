import path from "node:path";
import { badInput } from "@coding-agents-space/shared";
import type { DriftMode, Input } from "../types.js";

const REVIEW_SEVERITIES = new Set(["critical", "high", "medium", "low", "info"]);
const DRIFT_VERIFICATION_STATUSES = new Set(["verified", "violated", "partial", "unverifiable"]);
const DRIFT_CLAIM_TYPES = new Set(["interface", "invariant", "security", "performance", "docs"]);

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const assertNoUnexpectedProperties = (
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

const validateExtractorClaim = (claim: unknown): void => {
  if (!isObjectRecord(claim)) throw badInput("Each extractor claim must be an object");
  assertNoUnexpectedProperties(
    claim,
    ["id", "claim", "claim_type", "verification_status", "evidence", "confidence"],
    "extractor claim",
  );
  if (typeof claim.id !== "string" || claim.id.length === 0) {
    throw badInput("Each extractor claim must include a non-empty id");
  }
  if (typeof claim.claim !== "string" || claim.claim.length === 0) {
    throw badInput("Each extractor claim must include a non-empty claim");
  }
  validateExtractorClaimMetadata(claim);
};

const validateExtractorClaimMetadata = (claim: Record<string, unknown>): void => {
  validateSetValue(
    claim.verification_status,
    DRIFT_VERIFICATION_STATUSES,
    "Each extractor claim verification_status must be one of: verified, violated, partial, unverifiable",
  );
  validateOptionalSetValue(
    claim.claim_type,
    DRIFT_CLAIM_TYPES,
    "Each extractor claim claim_type must be one of: interface, invariant, security, performance, docs",
  );
  validateRequiredString(claim.evidence, "Each extractor claim must include non-empty evidence");
  validateConfidence(claim.confidence);
};

const validateSetValue = (value: unknown, values: Set<string>, message: string): void => {
  if (typeof value !== "string" || !values.has(value)) throw badInput(message);
};
const validateOptionalSetValue = (value: unknown, values: Set<string>, message: string): void => {
  if (value !== undefined) validateSetValue(value, values, message);
};
const validateRequiredString = (value: unknown, message: string): void => {
  if (typeof value !== "string" || value.length === 0) throw badInput(message);
};
const validateConfidence = (value: unknown): void => {
  if (value !== undefined && (typeof value !== "number" || value < 0 || value > 1))
    throw badInput("extractor claim confidence must be a number between 0 and 1");
};

const validateExtractorClaimSets = (claimSets: unknown): void => {
  if (!Array.isArray(claimSets) || claimSets.length !== 2) {
    throw badInput(
      "drift_config.extractor_claim_sets must contain exactly 2 claim sets in dual-extractor mode",
    );
  }
  for (const claimSet of claimSets) {
    validateExtractorClaimSet(claimSet);
  }
};

const validateExtractorClaimSet = (claimSet: unknown): void => {
  if (!isObjectRecord(claimSet)) throw badInput("Each extractor_claim_set must be an object");
  assertNoUnexpectedProperties(claimSet, ["extractor", "claims"], "extractor_claim_set");
  validateRequiredString(
    claimSet.extractor,
    "Each extractor_claim_set requires a non-empty extractor string",
  );
  validateClaims(claimSet.claims, "Each extractor_claim_set requires a non-empty claims array");
};

const validateClaims = (claims: unknown, message: string): void => {
  if (!Array.isArray(claims) || claims.length === 0) throw badInput(message);
  for (const claim of claims) validateExtractorClaim(claim);
};

const validateReviewerFinding = (finding: unknown): void => {
  if (!isObjectRecord(finding)) throw badInput("Each reviewer finding must be an object");
  assertNoUnexpectedProperties(
    finding,
    ["id", "category", "description", "severity", "evidence", "suggestion"],
    "reviewer finding",
  );
  if (typeof finding.id !== "string" || finding.id.length === 0) {
    throw badInput("Each reviewer finding must include a non-empty id");
  }
  if (typeof finding.category !== "string" || finding.category.length === 0) {
    throw badInput("Each reviewer finding must include a non-empty category");
  }
  if (typeof finding.description !== "string" || finding.description.length === 0) {
    throw badInput("Each reviewer finding must include a non-empty description");
  }
  validateReviewerFindingMetadata(finding);
};

const validateReviewerFindingMetadata = (finding: Record<string, unknown>): void => {
  if (typeof finding.severity !== "string" || !REVIEW_SEVERITIES.has(finding.severity)) {
    throw badInput(
      "Each reviewer finding severity must be one of: critical, high, medium, low, info",
    );
  }
  if (finding.evidence !== undefined && typeof finding.evidence !== "string") {
    throw badInput("Each reviewer finding evidence must be a string when provided");
  }
  if (finding.suggestion !== undefined && typeof finding.suggestion !== "string") {
    throw badInput("Each reviewer finding suggestion must be a string when provided");
  }
};

const validateReviewerFindings = (reviewerFindings: unknown): void => {
  if (!Array.isArray(reviewerFindings)) {
    throw badInput("reviewer_findings must be an array when provided");
  }
  if (reviewerFindings.length === 0) {
    throw badInput("reviewer_findings must be a non-empty array when provided");
  }

  for (const reviewer of reviewerFindings) {
    validateReviewer(reviewer);
  }
};

const validateReviewer = (reviewer: unknown): void => {
  if (!isObjectRecord(reviewer)) throw badInput("Each reviewer_findings entry must be an object");
  assertNoUnexpectedProperties(
    reviewer,
    ["reviewer_id", "role", "findings"],
    "reviewer_findings entry",
  );
  validateRequiredString(reviewer.reviewer_id, "Each reviewer_findings entry requires reviewer_id");
  validateRequiredString(reviewer.role, "Each reviewer_findings entry requires role");
  validateFindings(reviewer.findings);
};

const validateFindings = (findings: unknown): void => {
  if (!Array.isArray(findings))
    throw badInput("Each reviewer_findings entry requires a findings array");
  if (findings.length === 0)
    throw badInput("Each reviewer_findings entry requires a non-empty findings array");
  for (const finding of findings) validateReviewerFinding(finding);
};

const validateDriftConfig = (
  driftConfig: unknown,
): { targetRef?: string; driftMode: DriftMode; hasExtractorClaimSets: boolean } | undefined => {
  if (driftConfig === undefined) {
    return undefined;
  }
  if (!isObjectRecord(driftConfig)) {
    throw badInput("drift_config must be an object when provided");
  }
  assertNoUnexpectedProperties(
    driftConfig,
    ["source_ref", "target_ref", "mode", "extractor_claim_sets"],
    "drift_config",
  );

  const targetRef = validateTargetRef(driftConfig);
  validateOptionalString(
    driftConfig.source_ref,
    "drift_config.source_ref must be a string when provided",
  );
  const driftMode = validateDriftMode(driftConfig.mode);
  const hasExtractorClaimSets = driftConfig.extractor_claim_sets !== undefined;
  if (hasExtractorClaimSets) {
    validateExtractorClaimSets(driftConfig.extractor_claim_sets);
  }

  return { targetRef, driftMode, hasExtractorClaimSets };
};

const validateOptionalString = (value: unknown, message: string): void => {
  if (value !== undefined && typeof value !== "string") throw badInput(message);
};

const validateDriftMode = (value: unknown): DriftMode => {
  if (value === undefined) return "heuristic";
  if (value === "heuristic" || value === "dual-extractor") return value;
  throw badInput("drift_config.mode must be 'heuristic' or 'dual-extractor'");
};

const validateTargetRef = (driftConfig: Record<string, unknown>): string | undefined => {
  if (!("target_ref" in driftConfig)) return undefined;
  if (typeof driftConfig.target_ref !== "string") {
    throw badInput("drift_config.target_ref must be a string when provided");
  }
  if (driftConfig.target_ref.length > 0 && path.isAbsolute(driftConfig.target_ref)) {
    throw badInput("drift_config.target_ref must resolve within workspaceRoot");
  }
  return driftConfig.target_ref;
};

const validateActionAndDocument = (input: Input): void => {
  validateAction(input.action);
  validateDocument(input.document);
};

const validateAction = (action: unknown): void => {
  if (!isObjectRecord(action)) throw badInput("action must be an object");
  assertNoUnexpectedProperties(action, ["type"], "action");
  if (action.type !== "review" && action.type !== "drift-detect")
    throw badInput("action.type must be 'review' or 'drift-detect'");
};

const validateDocument = (document: unknown): void => {
  if (!isObjectRecord(document)) throw badInput("document must be an object");
  assertNoUnexpectedProperties(document, ["content", "type"], "document");
  validateRequiredString(document.content, "document.content is required");
  if (document.type !== "design" && document.type !== "plan" && document.type !== "implementation")
    throw badInput("document.type must be design, plan, or implementation");
};

const validateDriftAction = (
  input: Input,
  config: { targetRef?: string; driftMode: DriftMode; hasExtractorClaimSets: boolean } | undefined,
): void => {
  if (!config?.targetRef)
    throw badInput("drift_config.target_ref is required for drift-detect action");
  if (config.driftMode === "dual-extractor" && !config.hasExtractorClaimSets) {
    throw badInput(
      "drift_config.extractor_claim_sets must contain exactly 2 claim sets in dual-extractor mode",
    );
  }
  if (!["design", "plan"].includes(input.document.type)) {
    throw badInput("drift-detect requires document.type to be design or plan");
  }
};

export function validateInput(input: Input): void {
  if (!isObjectRecord(input)) {
    throw badInput("input must be a JSON object");
  }
  assertNoUnexpectedProperties(
    input as Record<string, unknown>,
    ["action", "document", "reviewer_findings", "drift_config"],
    "input",
  );

  validateActionAndDocument(input);

  if (input.reviewer_findings !== undefined) {
    validateReviewerFindings(input.reviewer_findings);
  }
  const validatedDriftConfig = validateDriftConfig(input.drift_config);

  if (input.action.type === "review") {
    if (input.reviewer_findings === undefined) {
      throw badInput("reviewer_findings must be a non-empty array for review action");
    }
    return;
  }

  validateDriftAction(input, validatedDriftConfig);
}
