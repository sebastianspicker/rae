/**
 * Phase-specific artifact builders and defaults.
 *
 * These builders create deterministic fixture artifacts for tests, evals, and
 * smoke runs. Human-authored non-fixture artifacts should be supplied through
 * --input-artifact and then validated by the same gate path.
 */
import { badInput } from "../primitives/errors.js";
import { buildDesignArtifact } from "./artifact-design.js";
import {
  buildQualityArtifact,
  buildReleaseReadinessArtifact,
} from "./artifact-quality-builders.js";
import { nowIso } from "./trace.js";
import { toNumber } from "../primitives/stage-values.js";

type StageProfile = Record<string, unknown>;
interface StageBudget {
  token_max?: number;
}
interface TaskShape extends Record<string, unknown> {
  id?: unknown;
  must_requirement_ids?: unknown;
}
interface ArtifactContext {
  requirements: string[];
  task?: TaskShape;
  runId: string;
  configId: string;
  stageProfile: StageProfile;
  now: string;
}
type Artifact = Record<string, unknown>;

export const DEFAULT_SCHEMA_BY_PHASE = {
  arm: "packages/contracts/v1/schemas/artifacts/brief.schema.json",
  design: "packages/contracts/v1/schemas/artifacts/design-document.schema.json",
  "adversarial-review": "packages/contracts/v1/schemas/artifacts/review-report.schema.json",
  plan: "packages/contracts/v1/schemas/artifacts/execution-plan.schema.json",
  pmatch: "packages/contracts/v1/schemas/artifacts/drift-report.schema.json",
  build: "packages/contracts/v1/schemas/artifacts/build-report.schema.json",
  "quality-static": "packages/contracts/v1/schemas/artifacts/quality-report.schema.json",
  "quality-tests": "packages/contracts/v1/schemas/artifacts/quality-report.schema.json",
  "release-readiness": "packages/contracts/v1/schemas/artifacts/release-readiness.schema.json",
};

const DEFAULT_ARTIFACT_REF_BY_PHASE = {
  arm: "brief.json",
  design: "design.json",
  "adversarial-review": "review.json",
  plan: "plan.json",
  pmatch: "drift-reports/pmatch.json",
  build: "build.json",
  "quality-static": "quality-reports/static.json",
  "quality-tests": "quality-reports/tests.json",
  "post-build": "quality-reports/post-build.json",
  "release-readiness": "release-readiness.json",
};
type ArtifactPhase = keyof typeof DEFAULT_ARTIFACT_REF_BY_PHASE;
type SchemaPhase = keyof typeof DEFAULT_SCHEMA_BY_PHASE;

export function phaseArtifactDefaults(phase: string): { artifactRef: string; schemaRef: string } {
  const artifactRef = DEFAULT_ARTIFACT_REF_BY_PHASE[phase as ArtifactPhase];
  if (!artifactRef) throw badInput(`unknown phase: ${phase}`);
  const schemaPhase = (phase === "post-build" ? "quality-tests" : phase) as SchemaPhase;
  return { artifactRef, schemaRef: DEFAULT_SCHEMA_BY_PHASE[schemaPhase] };
}

export function buildContextManifest({
  phase,
  stageProfile,
  budget,
}: {
  phase: string;
  stageProfile: StageProfile;
  budget?: StageBudget | null;
}): Record<string, unknown> | undefined {
  if (stageProfile.context_manifest_present === false) {
    return undefined;
  }

  const filesLoaded = Math.max(0, Math.trunc(toNumber(stageProfile.files_loaded, 3)));
  const tokenEstimate = Math.max(
    0,
    Math.trunc(
      toNumber(
        stageProfile.token_estimate,
        budget?.token_max ? Math.min(4000, budget.token_max) : 2000,
      ),
    ),
  );
  const charEstimate = Math.max(
    0,
    Math.trunc(toNumber(stageProfile.char_count_estimate, tokenEstimate * 4)),
  );

  return {
    selection_policy: "taskset-default-minimal",
    ordering_policy: "requirements-first-then-recent-artifacts",
    files_loaded: Array.from({ length: filesLoaded }, (_, idx) => ({
      path: `docs/task/${phase}/source-${idx + 1}.md`,
      bytes: 400 + idx * 20,
    })),
    docs_loaded: [
      {
        url: "https://example.com/reference",
        retrieved_at: nowIso(),
      },
    ],
    token_estimate: tokenEstimate,
    char_count_estimate: charEstimate,
  };
}

function buildTaskContextManifest(scopeRef: string): Record<string, unknown> {
  // Task sessions carry a tiny explicit context manifest so traceability tests
  // can distinguish "no context contract" from "small scoped context".
  return {
    selection_policy: "task-scoped-minimal",
    ordering_policy: "owned-files-first-then-requirements",
    files_loaded: [
      {
        path: scopeRef,
        bytes: 512,
      },
    ],
    docs_loaded: [
      {
        url: "https://example.com/task-context",
        retrieved_at: nowIso(),
      },
    ],
    token_estimate: 1200,
    char_count_estimate: 4800,
  };
}

export function defaultRequirementIds(task?: TaskShape | null): string[] {
  const ids = Array.isArray(task?.must_requirement_ids)
    ? task.must_requirement_ids.filter(
        (id): id is string => typeof id === "string" && id.length > 0,
      )
    : [];
  return ids.length > 0 ? ids : ["REQ-001"];
}

type DriftStatus = "verified" | "partial" | "violated";
export function driftStatusForConfig(configId: string, stageProfile: StageProfile): DriftStatus {
  if (["verified", "partial", "violated"].includes(String(stageProfile.drift_status))) {
    return stageProfile.drift_status as DriftStatus;
  }
  if (configId === "baseline_single_agent") return "violated";
  if (configId === "phased_with_context_budgets") return "partial";
  if (configId === "phased_dual_extractor_drift") return "verified";
  return "partial";
}

function buildArmArtifact({ requirements, task }: ArtifactContext): Artifact {
  return {
    requirements: requirements.map((id, idx) => ({
      id,
      trace_id: id,
      description: `Requirement ${idx + 1} for ${task?.id ?? "task"}`,
      priority: "must",
    })),
    constraints: [
      {
        type: "hard",
        description: "Must keep contracts valid",
        source: "taskset",
      },
    ],
    non_goals: [
      {
        description: "No external deployment",
        reason: "Out of scope for evaluation",
      },
    ],
    style: {
      tone: "technical",
      patterns: ["phase-scoped"],
      conventions: ["typed-artifacts"],
    },
    key_concepts: [
      {
        term: "traceability",
        definition: "Requirement linkage across artifacts",
      },
    ],
    decisions: [
      {
        decision: "Use phased orchestration",
        rationale: "Deterministic gate control",
      },
    ],
    open_questions: [],
  };
}

function buildReviewer({
  modelId,
  id,
  traceId,
  description,
  suggestion,
  requirementId,
}: {
  modelId: string;
  id: string;
  traceId: string;
  description: string;
  suggestion: string;
  requirementId: string;
}): Record<string, unknown> {
  return {
    model_id: modelId,
    findings: [
      {
        id,
        trace_id: traceId,
        category: "robustness",
        description,
        severity: "medium",
        covers_requirement_ids: [requirementId],
        evidence: "review signal",
        suggestion,
      },
    ],
  };
}

function buildAdversarialReviewArtifact({ requirements }: ArtifactContext): Artifact {
  const reviewers = [
    buildReviewer({
      modelId: "architect-reviewer",
      id: "finding-1",
      traceId: "finding-trace-1",
      description: "Check requirement linkage remains intact.",
      suggestion: "Keep coverage-min enforced",
      requirementId: requirements[0],
    }),
    buildReviewer({
      modelId: "security-engineer",
      id: "finding-2",
      traceId: "finding-trace-2",
      description: "Check trust-boundary assumptions remain explicit.",
      suggestion: "Keep security findings evidence-backed",
      requirementId: requirements[0],
    }),
    buildReviewer({
      modelId: "performance-engineer",
      id: "finding-3",
      traceId: "finding-trace-3",
      description: "Check gate execution does not add avoidable work.",
      suggestion: "Keep pipeline work bounded",
      requirementId: requirements[0],
    }),
  ];

  return {
    reviewers,
    deduplicated_findings: [
      {
        id: "dedup-1",
        trace_id: "dedup-trace-1",
        category: "robustness",
        description: "Ensure requirement coverage gates are active.",
        severity: "medium",
        source_models: reviewers.map((entry) => entry.model_id),
        covers_requirement_ids: [requirements[0]],
        evidence: "deduplicated",
        suggestion: "Use traceability gate",
      },
    ],
    fact_checks: [
      {
        finding_id: "dedup-1",
        status: "confirmed",
        evidence: "coverage-min criterion validates linkage",
      },
    ],
    cost_benefit: [
      {
        finding_id: "dedup-1",
        severity: "medium",
        fix_cost: "low",
        risk_of_ignoring: "moderate",
        recommendation: "fix-before-ship",
      },
    ],
    mitigations: [{ finding_id: "dedup-1", status: "mitigated", action: "Gate added" }],
    iteration: { loop_count: 1, remaining_unmitigated: [] },
  };
}

function buildFreshExecutionSession(
  sessionId: string,
  sessionKind: string,
): Record<string, unknown> {
  return {
    session_id: sessionId,
    session_kind: sessionKind,
    fresh_context: true,
    inherits_history: false,
    max_attempts: 2,
    retry_behavior: "restart-fresh-session",
  };
}

function buildPlanTestCase(testCoverage: string[]): Record<string, unknown> {
  return {
    name: "runner-contract-smoke",
    trace_id: "test-trace-1",
    execution_session: buildFreshExecutionSession(
      "quality-case-runner-contract-smoke",
      "quality-case",
    ),
    context_manifest: buildTaskContextManifest("packages/engine/src/cli/runner.js"),
    covers_requirement_ids: testCoverage,
    setup: "Initialize pipeline",
    assertion: "Run stage completes",
    expected: "gate passes",
  };
}

function buildPlanTask(
  requirementCoverage: string[],
  testCoverage: string[],
): Record<string, unknown> {
  return {
    id: "task-1",
    trace_id: "task-trace-1",
    description: "Implement orchestrated runner flow",
    execution_session: buildFreshExecutionSession("build-task-1", "build-task"),
    context_manifest: buildTaskContextManifest("packages/engine/src/cli/runner.js"),
    covers_requirement_ids: requirementCoverage,
    covers_constraint_ids: ["constraint-contracts"],
    file_paths: ["packages/engine/src/cli/runner.js"],
    code_patterns: [
      {
        file: "packages/engine/src/cli/runner.js",
        pattern: "run-stage",
        description: "runtime stage execution",
      },
    ],
    test_cases: [buildPlanTestCase(testCoverage)],
    acceptance_criteria: ["trace events emitted", "gate output persisted"],
    dependencies: [],
  };
}

function buildPlanArtifact({ requirements, stageProfile }: ArtifactContext): Artifact {
  const requirementCoverage = [...requirements];
  const testCoverage =
    stageProfile.traceability_gap === true ? requirements.slice(0, 1) : [...requirements];
  return {
    task_groups: [
      {
        group_id: "group-1",
        builder_tier: "fast",
        tasks: [buildPlanTask(requirementCoverage, testCoverage)],
      },
    ],
    file_ownership: {
      "packages/engine/src/cli/runner.js": "group-1",
    },
    documentation: {
      required: false,
      paths: [],
      rationale: "The deterministic fixture exercises the runner without changing public behavior.",
    },
    verification_commands: [
      {
        command: "npm run rae -- orchestrate run-stage --help",
        description: "Ensure runner CLI is available",
        working_directory: ".",
        evidence_roles: ["build", "quality-static"],
        evidence_kind: "static",
      },
    ],
  };
}

function pmatchMode(configId: string, stageProfile: StageProfile): string {
  const dualExtractor =
    configId === "phased_dual_extractor_drift" || stageProfile.drift_mode === "dual-extractor";
  return dualExtractor ? "dual-extractor" : "heuristic";
}

function driftScore(status: DriftStatus): number {
  return { verified: 0, partial: 0.5, violated: 1 }[status] ?? 0.75;
}

function driftFindings(status: DriftStatus): Array<Record<string, unknown>> {
  if (status === "verified") return [];
  return [
    {
      description: `Drift status is ${status} for runner gate emission`,
      claim_type: "invariant",
      severity: status === "violated" ? "high" : "medium",
      claim_ids: ["drift-1"],
      mitigation: "Reconcile implementation with plan coverage",
    },
  ];
}

function driftAdjudication(mode: string): Record<string, unknown> {
  const dualExtractor = mode === "dual-extractor";
  return {
    mode,
    extractors: dualExtractor ? ["extractor-a", "extractor-b"] : ["rule-based-drift-detector"],
    conflicts_resolved: dualExtractor ? 1 : 0,
    resolution_policy: dualExtractor
      ? "adjudicated dual extractor conflict policy"
      : "keyword overlap deterministic thresholds",
  };
}

function buildPmatchArtifact({
  requirements,
  runId,
  configId,
  stageProfile,
}: ArtifactContext): Artifact {
  const status = driftStatusForConfig(configId, stageProfile);
  const mode = pmatchMode(configId, stageProfile);

  return {
    source_document: { type: "plan", ref: `.pipeline/runs/${runId}/plan.json` },
    target_document: { type: "implementation", ref: "packages/engine/src/cli/runner.js" },
    claims: [
      {
        id: "drift-1",
        trace_id: "drift-trace-1",
        claim: "Runner must emit phase gate events",
        claim_type: "invariant",
        covers_requirement_ids: requirements,
        verification_status: status,
        evidence: status === "verified" ? "events observed" : "simulated development signal",
        extractor: mode === "dual-extractor" ? "dual-adjudicator:a+b" : "rule-based-drift-detector",
        drift_score: driftScore(status),
        confidence: 0.8,
      },
    ],
    findings: driftFindings(status),
    adjudication: driftAdjudication(mode),
  };
}

function buildBuildArtifact({ requirements }: ArtifactContext): Artifact {
  return {
    trace_id: "build-trace-1",
    summary: "Build phase executed by runner",
    outputs: ["packages/engine/src/cli/runner.js"],
    covers_requirement_ids: [...requirements],
  };
}

type ArtifactBuilder = (context: ArtifactContext) => Artifact;
const PHASE_BUILDERS = new Map<string, ArtifactBuilder>([
  ["arm", (ctx) => buildArmArtifact(ctx)],
  ["design", (ctx) => buildDesignArtifact(ctx)],
  ["adversarial-review", (ctx) => buildAdversarialReviewArtifact(ctx)],
  ["plan", (ctx) => buildPlanArtifact(ctx)],
  ["pmatch", (ctx) => buildPmatchArtifact(ctx)],
  ["build", (ctx) => buildBuildArtifact(ctx)],
  ["quality-static", () => buildQualityArtifact("static") as Artifact],
  ["quality-tests", () => buildQualityArtifact("tests") as Artifact],
  ["post-build", () => buildQualityArtifact("security") as Artifact],
  ["release-readiness", (ctx) => buildReleaseReadinessArtifact(ctx)],
]);

export function buildArtifactForPhase({
  phase,
  runId,
  configId,
  task,
  stageProfile,
  budget,
}: {
  phase: string;
  runId: string;
  configId: string;
  task?: TaskShape;
  stageProfile: StageProfile;
  budget?: StageBudget | null;
}): Artifact | null {
  const builder = PHASE_BUILDERS.get(phase);
  if (!builder) return null;

  const requirements = defaultRequirementIds(task);
  if (!requirements.length)
    throw badInput("requirements array must not be empty for artifact generation");
  const contextManifest = buildContextManifest({ phase, stageProfile, budget });
  const now = nowIso();

  const artifact = builder({
    requirements,
    task,
    runId,
    configId,
    stageProfile,
    now,
  });
  return contextManifest ? { ...artifact, context_manifest: contextManifest } : artifact;
}
