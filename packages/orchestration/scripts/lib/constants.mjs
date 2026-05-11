/**
 * Pipeline execution order — the 10 sequenced delivery phases.
 * This is NOT all valid gate phases. Sub-phases (denoise, quality-frontend,
 * quality-backend, quality-docs, security-review) are valid gate phases
 * but not pipeline execution phases. See quality-gate VALID_GATE_PHASES
 * for the complete gate phase set.
 */
export const PHASE_ORDER = [
  "arm",
  "design",
  "adversarial-review",
  "plan",
  "pmatch",
  "build",
  "quality-static",
  "quality-tests",
  "post-build",
  "release-readiness",
];

export const CONFIG_IDS = [
  "baseline_single_agent",
  "phased_default",
  "phased_with_context_budgets",
  "phased_dual_extractor_drift",
];

export const DEFAULT_CONFIG_ID = "phased_default";

export const SKILL_ENTRYPOINTS = {
  quality_gate: "skills/dev-tools/quality-gate/dist/index.js",
  trace_collector: "skills/dev-tools/trace-collector/dist/index.js",
};
