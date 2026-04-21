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

function estimateFixCost(finding: Finding): Cost {
  if (HIGH_COST_CATEGORIES.has(finding.category.toLowerCase())) {
    return finding.severity === "critical" ? "prohibitive" : "high";
  }
  if (finding.description.length <= 80) return "trivial";
  if (finding.description.length > 300) return "medium";
  return "low";
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
function recommend(risk: Risk, cost: Cost): Rec {
  if (risk === "catastrophic") return "fix-now";
  if (risk === "high") return cost === "trivial" || cost === "low" ? "fix-now" : "fix-before-ship";
  if (risk === "moderate")
    return cost === "trivial" || cost === "low" ? "fix-before-ship" : "defer";
  if (risk === "low") return cost === "high" || cost === "prohibitive" ? "wont-fix" : "accept";
  return cost === "trivial" || cost === "low" ? "accept" : "wont-fix";
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
