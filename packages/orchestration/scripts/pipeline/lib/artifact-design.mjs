/** Builds the design-phase artifact from validated requirements. */
export function buildDesignArtifact({ requirements, now }) {
  return {
    analysis: {
      summary: "Design is constrained by contracts and gateability.",
      principles: [{ principle: "Minimize context noise", implication: "Phase-local manifests" }],
    },
    constraints_classification: [
      {
        constraint: "Contracts must remain valid",
        trace_id: "constraint-contracts",
        covers_requirement_ids: [requirements[0]],
        original_type: "hard",
        validated_type: "hard",
        evaluation: "Required for deterministic gates",
        flagged: false,
      },
    ],
    approach: {
      description: "Generate artifacts per phase and enforce gates.",
      rationale: "Keeps runner deterministic.",
      components: [{ name: "runner", responsibility: "Phase transitions", interfaces: ["CLI"] }],
    },
    research: [
      {
        source: "repo-docs",
        url: "https://example.com/research",
        finding: "Phase scoping is beneficial.",
        verified_at: now,
      },
    ],
    codebase_alignment: [
      {
        pattern: "scripts/pipeline/*",
        file_paths: ["scripts/pipeline/runner.mjs"],
        alignment_status: "new",
        notes: "runtime orchestration",
      },
    ],
    iteration_history: [
      { iteration: 1, changes: "Initial design", rationale: "Enable runtime gates" },
    ],
  };
}
