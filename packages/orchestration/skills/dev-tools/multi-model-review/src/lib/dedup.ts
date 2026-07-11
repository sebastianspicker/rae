import type { Finding } from "./models/types.js";
import type { DedupFinding } from "../types.js";

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 1),
  );
}

/**
 * Token-overlap Jaccard similarity: |A ∩ B| / |A ∪ B|
 * Accepts either raw strings or pre-tokenized Sets for performance.
 */
export function tokenSimilarity(a: string | Set<string>, b: string | Set<string>): number {
  const tokA = typeof a === "string" ? tokenize(a) : a;
  const tokB = typeof b === "string" ? tokenize(b) : b;
  if (tokA.size === 0 && tokB.size === 0) return 1;
  if (tokA.size === 0 || tokB.size === 0) return 0;

  let intersection = 0;
  for (const t of tokA) {
    if (tokB.has(t)) intersection++;
  }
  const union = tokA.size + tokB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

const SIMILARITY_THRESHOLD = 0.7;

export interface TaggedFinding extends Finding {
  _source: string;
  trace_id?: string;
  covers_requirement_ids?: string[];
}

export function deduplicateFindings(taggedFindings: TaggedFinding[]): DedupFinding[] {
  const groups = groupByCategory(taggedFindings);
  const cachedTokenize = tokenCache();
  const results: DedupFinding[] = [];
  for (const findings of groups.values()) results.push(...mergeCategory(findings, cachedTokenize));
  return results;
}

function groupByCategory(findings: TaggedFinding[]): Map<string, TaggedFinding[]> {
  const groups = new Map<string, TaggedFinding[]>();
  for (const finding of findings) {
    const key = finding.category.toLowerCase().trim();
    const group = groups.get(key) ?? [];
    group.push(finding);
    groups.set(key, group);
  }
  return groups;
}
function tokenCache(): (text: string) => Set<string> {
  const cache = new Map<string, Set<string>>();
  return (text) => {
    const tokens = cache.get(text) ?? tokenize(text);
    cache.set(text, tokens);
    return tokens;
  };
}
function mergeCategory(
  findings: TaggedFinding[],
  tokens: (text: string) => Set<string>,
): DedupFinding[] {
  const merged: DedupFinding[] = [];
  for (const finding of findings) {
    const target = merged.find(
      (entry) =>
        tokenSimilarity(tokens(finding.description), tokens(entry.description)) >=
        SIMILARITY_THRESHOLD,
    );
    if (target) mergeFinding(target, finding);
    else merged.push(toDedupFinding(finding));
  }
  return merged;
}
const mergeFinding = (target: DedupFinding, finding: TaggedFinding): void => {
  mergeSourceAndSeverity(target, finding);
  mergeOptionalDetails(target, finding);
  mergeRequirementIds(target, finding);
};

const mergeSourceAndSeverity = (target: DedupFinding, finding: TaggedFinding): void => {
  if (!target.source_models.includes(finding._source)) target.source_models.push(finding._source);
  if (severityRank(finding.severity) > severityRank(target.severity))
    target.severity = finding.severity;
};

const mergeOptionalDetails = (target: DedupFinding, finding: TaggedFinding): void => {
  if (finding.evidence && !target.evidence) target.evidence = finding.evidence;
  if (finding.suggestion && !target.suggestion) target.suggestion = finding.suggestion;
  if (finding.trace_id && !target.trace_id) target.trace_id = finding.trace_id;
};

const mergeRequirementIds = (target: DedupFinding, finding: TaggedFinding): void => {
  if (!finding.covers_requirement_ids?.length) return;
  target.covers_requirement_ids = [
    ...new Set([...(target.covers_requirement_ids ?? []), ...finding.covers_requirement_ids]),
  ];
};
function toDedupFinding(finding: TaggedFinding): DedupFinding {
  return {
    id: finding.id,
    category: finding.category,
    description: finding.description,
    severity: finding.severity,
    evidence: finding.evidence,
    suggestion: finding.suggestion,
    source_models: [finding._source],
    ...(finding.trace_id ? { trace_id: finding.trace_id } : {}),
    ...(finding.covers_requirement_ids?.length
      ? { covers_requirement_ids: [...finding.covers_requirement_ids] }
      : {}),
  };
}

function severityRank(s: Finding["severity"]): number {
  const ranks: Record<Finding["severity"], number> = {
    info: 0,
    low: 1,
    medium: 2,
    high: 3,
    critical: 4,
  };
  return ranks[s];
}
