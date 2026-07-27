/**
 * Coordinates review and drift-detection operations over validated tool input.
 */
import { readFileSync } from "node:fs";
import type {
  DedupFinding,
  DriftConfig,
  DriftData,
  DriftMode,
  FactCheckEntry,
  Input,
  ExtractorClaimSet,
  MitigationEntry,
  ReviewData,
  ReviewerSummary,
} from "../types.js";
import { resolveWithinWorkspace } from "@coding-agents-space/shared";
import type { ReviewerFindings } from "./models/types.js";
import { deduplicateFindings, type TaggedFinding } from "./dedup.js";
import { analyzeCostBenefit } from "./cost-benefit.js";
import { detectDrift, detectDriftFromExtractorClaims, type DriftDetectionResult } from "./drift.js";
export { validateInput } from "./input.js";

interface RunDriftDetectOptions {
  workspaceRoot?: string;
}

function buildFactChecks(findings: DedupFinding[]): FactCheckEntry[] {
  const factChecks: FactCheckEntry[] = [];
  for (const finding of findings) {
    factChecks.push({
      finding_id: finding.id,
      status: "inconclusive",
      evidence: `Pending lead verification; reported by: ${finding.source_models.join(", ")}`,
    });
  }
  return factChecks;
}

function inferTargetType(sourceType: "design" | "plan"): "plan" | "implementation" {
  return sourceType === "design" ? "plan" : "implementation";
}

function resolveTargetPath(workspaceRoot: string, targetRef: string): string {
  return resolveWithinWorkspace(workspaceRoot, targetRef, "drift_config.target_ref");
}

function readTargetDocument(targetRef: string, logs: string[]): string {
  try {
    return readFileSync(targetRef, "utf8");
  } catch {
    logs.push("Could not read target_ref");
    throw Object.assign(new Error("Could not read target_ref"), {
      code: "E_TARGET_READ",
    });
  }
}

/**
 * Normalizes reviewer outputs into a deterministic deduplicated review report.
 */
export function runReview(input: Input, logs: string[]): ReviewData {
  const reviewerFindings = input.reviewer_findings as ReviewerFindings[];
  const taggedFindings: TaggedFinding[] = [];
  const reviewers: ReviewerSummary[] = [];

  for (const rf of reviewerFindings) {
    reviewers.push({
      model_id: rf.reviewer_id,
      findings: rf.findings,
    });
    logs.push(
      `Processing findings from reviewer: ${rf.reviewer_id} (${rf.role}), ${rf.findings.length} findings`,
    );
    for (const f of rf.findings) {
      taggedFindings.push({ ...f, _source: rf.reviewer_id });
    }
  }

  const deduplicated = deduplicateFindings(taggedFindings);
  const costBenefit = analyzeCostBenefit(deduplicated);
  const factChecks = buildFactChecks(deduplicated);
  const mitigations: MitigationEntry[] = [];
  const remainingUnmitigated = deduplicated.map((f) => f.id);

  logs.push(`Deduplicated ${taggedFindings.length} findings into ${deduplicated.length}`);

  return {
    reviewers,
    deduplicated_findings: deduplicated,
    fact_checks: factChecks,
    cost_benefit: costBenefit,
    mitigations,
    iteration: {
      loop_count: 1,
      remaining_unmitigated: remainingUnmitigated,
    },
  };
}

/**
 * Computes drift evidence from validated claim sets and workspace-contained target documents.
 */
export function runDriftDetect(
  input: Input,
  logs: string[],
  opts: RunDriftDetectOptions = {},
): DriftData {
  const sourceType = input.document.type as "design" | "plan";
  const sourceText = input.document.content;
  const driftConfig = input.drift_config as DriftConfig;
  const targetRef = driftConfig.target_ref as string;
  const workspaceRoot = opts.workspaceRoot ?? "/workspace";
  const driftMode: DriftMode = driftConfig.mode ?? "heuristic";
  const targetPath = resolveTargetPath(workspaceRoot, targetRef);

  // Keep existing behavior: drift-detect fails when target_ref cannot be read.
  const targetText = readTargetDocument(targetPath, logs);
  let detected: DriftDetectionResult;
  if (driftMode === "dual-extractor") {
    logs.push("Using dual-extractor drift adjudication mode");
    detected = detectDriftFromExtractorClaims(
      driftConfig.extractor_claim_sets as ExtractorClaimSet[],
    );
  } else {
    logs.push("Using heuristic drift detection mode");
    detected = detectDrift(sourceText, targetText);
  }

  return {
    source_document: {
      type: sourceType,
      ref: driftConfig.source_ref ?? "inline:document.content",
    },
    target_document: {
      type: inferTargetType(sourceType),
      ref: targetRef,
    },
    claims: detected.claims,
    findings: detected.findings,
    adjudication: detected.adjudication,
  };
}
