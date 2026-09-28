/**
 * Ranks review findings by remediation cost and risk to support deterministic triage.
 */
import type { Finding } from "./models/types.js";
import type { CostBenefitEntry } from "../types.js";

type Risk = CostBenefitEntry["risk_of_ignoring"];
type Cost = CostBenefitEntry["fix_cost"];
type Rec = CostBenefitEntry["recommendation"];
type Severity = CostBenefitEntry["severity"];

const SEVERITY_TO_RISK: Record<Finding["severity"], Risk> = {
  critical: "catastrophic",
  high: "high",
  medium: "moderate",
  low: "low",
  info: "negligible",
};

const HIGH_COST_CATEGORIES = new Set(["architecture", "feasibility", "performance"]);

const RECOMMENDATION_MATRIX: Record<Risk, Record<Cost, Rec>> = {
  catastrophic: {
    trivial: "fix-now",
    low: "fix-now",
    medium: "fix-now",
    high: "fix-now",
    prohibitive: "fix-now",
  },
  high: {
    trivial: "fix-now",
    low: "fix-now",
    medium: "fix-before-ship",
    high: "fix-before-ship",
    prohibitive: "fix-before-ship",
  },
  moderate: {
    trivial: "fix-before-ship",
    low: "fix-before-ship",
    medium: "defer",
    high: "defer",
    prohibitive: "defer",
  },
  low: {
    trivial: "accept",
    low: "accept",
    medium: "accept",
    high: "wont-fix",
    prohibitive: "wont-fix",
  },
  negligible: {
    trivial: "accept",
    low: "accept",
    medium: "wont-fix",
    high: "wont-fix",
    prohibitive: "wont-fix",
  },
};

export function estimateFixCost(finding: Finding): Cost {
  return HIGH_COST_CATEGORIES.has(finding.category.toLowerCase())
    ? highImpactCost(finding.severity)
    : descriptionCost(finding.description);
}

export function highImpactCost(severity: Severity): Cost {
  return severity === "critical" ? "prohibitive" : "high";
}

export function descriptionCost(description: string): Cost {
  if (description.length <= 80) return "trivial";
  return description.length > 300 ? "medium" : "low";
}

/**
 * Maps (risk, cost) to a recommendation.
 *
 * risk\cost     trivial      low          medium        high|prohibitive
 * catastrophic  fix-now      fix-now      fix-now       fix-now
 * high          fix-now      fix-now      fix-before    fix-before
 * moderate      fix-before   fix-before   defer         defer
 * low           accept       accept       accept        wont-fix
 * negligible    accept       accept       wont-fix      wont-fix
 */
export function recommend(risk: Risk, cost: Cost): Rec {
  return RECOMMENDATION_MATRIX[risk][cost];
}

export function costly(cost: Cost): boolean {
  return cost === "high" || cost === "prohibitive";
}

export function isCheap(cost: Cost): boolean {
  return cost === "trivial" || cost === "low";
}

export function recommendHighRisk(cost: Cost): Rec {
  return isCheap(cost) ? "fix-now" : "fix-before-ship";
}

export function recommendModerateRisk(cost: Cost): Rec {
  return isCheap(cost) ? "fix-before-ship" : "defer";
}

export function analyzeCostBenefit(findings: Finding[]): CostBenefitEntry[] {
  return findings.map((f) => {
    const severity: Severity = f.severity;
    const risk = SEVERITY_TO_RISK[f.severity];
    const cost = estimateFixCost(f);
    return {
      finding_id: f.id,
      severity,
      risk_of_ignoring: risk,
      fix_cost: cost,
      recommendation: recommend(risk, cost),
    };
  });
}
