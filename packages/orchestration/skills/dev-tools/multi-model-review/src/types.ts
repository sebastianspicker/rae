import type { Finding, ReviewerFindings } from "./lib/models/types.js";

export type ActionType = "review" | "drift-detect";
export type DocumentType = "design" | "plan" | "implementation";
export type ReviewSeverity = Finding["severity"];
export type FactCheckStatus = "confirmed" | "refuted" | "inconclusive";
export type MitigationStatus = "mitigated" | "deferred" | "accepted";
export type DriftVerificationStatus = "verified" | "violated" | "partial" | "unverifiable";
export type DriftMode = "heuristic" | "dual-extractor";
export type DriftClaimType = "interface" | "invariant" | "security" | "performance" | "docs";

export interface Action {
  type: ActionType;
}

export interface Document {
  content: string;
  type: DocumentType;
}

export interface ExtractorClaimInput {
  id: string;
  claim: string;
  claim_type?: DriftClaimType;
  verification_status: DriftVerificationStatus;
  evidence: string;
  confidence?: number;
}

export interface ExtractorClaimSet {
  extractor: string;
  claims: ExtractorClaimInput[];
}

export interface DriftConfig {
  source_ref?: string;
  target_ref?: string;
  mode?: DriftMode;
  extractor_claim_sets?: ExtractorClaimSet[];
}

export interface Input {
  action: Action;
  document: Document;
  reviewer_findings?: ReviewerFindings[];
  drift_config?: DriftConfig;
}

export interface CostBenefitEntry {
  finding_id: string;
  severity: ReviewSeverity;
  risk_of_ignoring: "catastrophic" | "high" | "moderate" | "low" | "negligible";
  fix_cost: "trivial" | "low" | "medium" | "high" | "prohibitive";
  recommendation: "fix-now" | "fix-before-ship" | "defer" | "accept" | "wont-fix";
}

export interface DedupFinding extends Finding {
  source_models: string[];
  trace_id?: string;
  covers_requirement_ids?: string[];
}

export interface FactCheckEntry {
  finding_id: string;
  status: FactCheckStatus;
  evidence: string;
}

export interface MitigationEntry {
  finding_id: string;
  status: MitigationStatus;
  action?: string;
  justification?: string;
}

export interface IterationInfo {
  loop_count: number;
  remaining_unmitigated: string[];
}

export interface ReviewerSummary {
  model_id: string;
  findings: Finding[];
}

export interface ReviewData {
  reviewers: ReviewerSummary[];
  deduplicated_findings: DedupFinding[];
  fact_checks: FactCheckEntry[];
  cost_benefit: CostBenefitEntry[];
  mitigations: MitigationEntry[];
  iteration: IterationInfo;
}

export interface SourceDocumentRef {
  type: "design" | "plan";
  ref: string;
}

export interface TargetDocumentRef {
  type: "plan" | "implementation";
  ref: string;
}

export interface DriftClaim {
  id: string;
  claim: string;
  claim_type: DriftClaimType;
  verification_status: DriftVerificationStatus;
  evidence: string;
  extractor: string;
  drift_score?: number;
  covers_requirement_ids?: string[];
  confidence?: number;
}

export interface DriftFinding {
  description: string;
  claim_type?: DriftClaimType;
  severity: "critical" | "high" | "medium" | "low";
  claim_ids: string[];
  mitigation?: string;
}

export interface DriftAdjudication {
  mode: DriftMode;
  extractors: string[];
  conflicts_resolved: number;
  resolution_policy: string;
}

export interface DriftData {
  source_document: SourceDocumentRef;
  target_document: TargetDocumentRef;
  claims: DriftClaim[];
  findings: DriftFinding[];
  adjudication: DriftAdjudication;
}
