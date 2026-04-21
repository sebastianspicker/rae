export const VALID_GATE_PHASES = [
  "arm",
  "design",
  "adversarial-review",
  "plan",
  "pmatch",
  "build",
  "quality-static",
  "quality-tests",
  "post-build",
  "denoise",
  "quality-frontend",
  "quality-backend",
  "quality-docs",
  "security-review",
  "release-readiness",
] as const;

export type GatePhase = (typeof VALID_GATE_PHASES)[number];

export function isGatePhase(value: unknown): value is GatePhase {
  return typeof value === "string" && VALID_GATE_PHASES.includes(value as GatePhase);
}
