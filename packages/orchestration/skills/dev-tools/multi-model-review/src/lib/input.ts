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
  if (
    typeof claim.verification_status !== "string" ||
    !DRIFT_VERIFICATION_STATUSES.has(claim.verification_status)
  ) {
    throw badInput(
      "Each extractor claim verification_status must be one of: verified, violated, partial, unverifiable",
    );
  }
  if (
    claim.claim_type !== undefined &&
    (typeof claim.claim_type !== "string" || !DRIFT_CLAIM_TYPES.has(claim.claim_type))
  ) {
    throw badInput(
      "Each extractor claim claim_type must be one of: interface, invariant, security, performance, docs",
    );
  }
  if (typeof claim.evidence !== "string" || claim.evidence.length === 0) {
    throw badInput("Each extractor claim must include non-empty evidence");
  }
  if (
    claim.confidence !== undefined &&
    (typeof claim.confidence !== "number" || claim.confidence < 0 || claim.confidence > 1)
  ) {
    throw badInput("extractor claim confidence must be a number between 0 and 1");
  }
};

const validateExtractorClaimSets = (claimSets: unknown): void => {
  if (!Array.isArray(claimSets) || claimSets.length !== 2) {
    throw badInput(
      "drift_config.extractor_claim_sets must contain exactly 2 claim sets in dual-extractor mode",
    );
  }
  for (const claimSet of claimSets) {
    if (!isObjectRecord(claimSet)) {
      throw badInput("Each extractor_claim_set must be an object");
    }
    assertNoUnexpectedProperties(claimSet, ["extractor", "claims"], "extractor_claim_set");
    if (typeof claimSet.extractor !== "string" || claimSet.extractor.length === 0) {
      throw badInput("Each extractor_claim_set requires a non-empty extractor string");
    }
    if (!Array.isArray(claimSet.claims) || claimSet.claims.length === 0) {
      throw badInput("Each extractor_claim_set requires a non-empty claims array");
    }
    for (const claim of claimSet.claims) {
      validateExtractorClaim(claim);
    }
  }
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
    if (!isObjectRecord(reviewer)) {
      throw badInput("Each reviewer_findings entry must be an object");
    }
    assertNoUnexpectedProperties(
      reviewer,
      ["reviewer_id", "role", "findings"],
      "reviewer_findings entry",
    );
    if (typeof reviewer.reviewer_id !== "string" || reviewer.reviewer_id.length === 0) {
      throw badInput("Each reviewer_findings entry requires reviewer_id");
    }
    if (typeof reviewer.role !== "string" || reviewer.role.length === 0) {
      throw badInput("Each reviewer_findings entry requires role");
    }
    if (!Array.isArray(reviewer.findings)) {
      throw badInput("Each reviewer_findings entry requires a findings array");
    }
    if (reviewer.findings.length === 0) {
      throw badInput("Each reviewer_findings entry requires a non-empty findings array");
    }
    for (const finding of reviewer.findings) {
      validateReviewerFinding(finding);
    }
  }
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
  if (driftConfig.source_ref !== undefined && typeof driftConfig.source_ref !== "string") {
    throw badInput("drift_config.source_ref must be a string when provided");
  }

  const driftModeRaw = (driftConfig as Record<string, unknown>).mode;
  if (
    driftModeRaw !== undefined &&
    driftModeRaw !== "heuristic" &&
    driftModeRaw !== "dual-extractor"
  ) {
    throw badInput("drift_config.mode must be 'heuristic' or 'dual-extractor'");
  }
  const driftMode: DriftMode = (driftModeRaw as DriftMode) ?? "heuristic";

  const hasExtractorClaimSets =
    (driftConfig as Record<string, unknown>).extractor_claim_sets !== undefined;
  if (hasExtractorClaimSets) {
    validateExtractorClaimSets((driftConfig as Record<string, unknown>).extractor_claim_sets);
  }

  return { targetRef, driftMode, hasExtractorClaimSets };
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
  if (!isObjectRecord(input.action)) throw badInput("action must be an object");
  assertNoUnexpectedProperties(input.action as Record<string, unknown>, ["type"], "action");
  if (!input.action.type || !["review", "drift-detect"].includes(input.action.type)) {
    throw badInput("action.type must be 'review' or 'drift-detect'");
  }
  if (!isObjectRecord(input.document)) throw badInput("document must be an object");
  assertNoUnexpectedProperties(
    input.document as Record<string, unknown>,
    ["content", "type"],
    "document",
  );
  if (!input.document.content || typeof input.document.content !== "string") {
    throw badInput("document.content is required");
  }
  if (!input.document.type || !["design", "plan", "implementation"].includes(input.document.type)) {
    throw badInput("document.type must be design, plan, or implementation");
  }
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
