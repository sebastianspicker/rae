/**
 * Defines normalized findings returned by individual review-model adapters.
 */
export interface Finding {
  id: string;
  category: string;
  description: string;
  severity: "critical" | "high" | "medium" | "low" | "info";
  evidence?: string;
  suggestion?: string;
}

export interface ReviewerFindings {
  reviewer_id: string;
  role: string;
  findings: Finding[];
}
