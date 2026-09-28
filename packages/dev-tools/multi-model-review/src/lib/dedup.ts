/**
 * Deduplicates reviewer findings while retaining source attribution and strongest evidence.
 */
import type { Finding } from "./models/types.js";
import type { DedupFinding } from "../types.js";

export function tokenize(text: string): Set<string> {
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
  const emptySimilarity = similarityForEmptySets(tokA, tokB);
  if (emptySimilarity !== undefined) return emptySimilarity;
  const intersection = countIntersection(tokA, tokB);
  const union = tokA.size + tokB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export function similarityForEmptySets(a: Set<string>, b: Set<string>): number | undefined {
  if (a.size === 0 && b.size === 0) return 1;
  return a.size === 0 || b.size === 0 ? 0 : undefined;
}

export function countIntersection(a: Set<string>, b: Set<string>): number {
  let intersection = 0;
  a.forEach((token) => {
    if (b.has(token)) intersection++;
  });
  return intersection;
}

const SIMILARITY_THRESHOLD = 0.7;

export interface TaggedFinding extends Finding {
  _source: string;
  trace_id?: string;
  covers_requirement_ids?: string[];
}

export function deduplicateFindings(taggedFindings: TaggedFinding[]): DedupFinding[] {
  const groups = groupFindingsByCategory(taggedFindings);
  const tokenCache = new Map<string, Set<string>>();
  return [...groups.values()].flatMap((findings) => deduplicateCategory(findings, tokenCache));
}

export function groupFindingsByCategory(findings: TaggedFinding[]): Map<string, TaggedFinding[]> {
  const groups = new Map<string, TaggedFinding[]>();
  findings.forEach((finding) => {
    const category = finding.category.toLowerCase().trim();
    groups.set(category, [...(groups.get(category) ?? []), finding]);
  });
  return groups;
}

export function deduplicateCategory(
  findings: TaggedFinding[],
  tokenCache: Map<string, Set<string>>,
): DedupFinding[] {
  const merged: DedupFinding[] = [];
  findings.forEach((finding) => {
    mergeOrAppend(merged, finding, tokenCache);
  });
  return merged;
}

export function mergeOrAppend(
  merged: DedupFinding[],
  finding: TaggedFinding,
  tokenCache: Map<string, Set<string>>,
): void {
  const existing = merged.find((candidate) => isSimilar(candidate, finding, tokenCache));
  if (existing) mergeFinding(existing, finding);
  else merged.push(toDedupFinding(finding));
}

export function isSimilar(
  candidate: DedupFinding,
  finding: TaggedFinding,
  tokenCache: Map<string, Set<string>>,
): boolean {
  return (
    tokenSimilarity(
      cachedTokenize(candidate.description, tokenCache),
      cachedTokenize(finding.description, tokenCache),
    ) >= SIMILARITY_THRESHOLD
  );
}

export function cachedTokenize(text: string, cache: Map<string, Set<string>>): Set<string> {
  const existing = cache.get(text);
  if (existing) return existing;
  const tokens = tokenize(text);
  cache.set(text, tokens);
  return tokens;
}

export function mergeFinding(existing: DedupFinding, incoming: TaggedFinding): void {
  addSourceModel(existing, incoming._source);
  promoteSeverity(existing, incoming);
  copyMissingEvidence(existing, incoming);
  copyMissingSuggestion(existing, incoming);
  copyMissingTraceId(existing, incoming);
  mergeRequirementIds(existing, incoming.covers_requirement_ids);
}

export function addSourceModel(existing: DedupFinding, source: string): void {
  if (!existing.source_models.includes(source)) existing.source_models.push(source);
}

export function promoteSeverity(existing: DedupFinding, incoming: TaggedFinding): void {
  if (severityRank(incoming.severity) > severityRank(existing.severity))
    existing.severity = incoming.severity;
}

export function fillOnlyIfAbsent<T extends object, K extends keyof T>(
  existing: T,
  incoming: Partial<T>,
  field: K,
): void {
  const incomingValue = incoming[field];
  if (incomingValue && !existing[field]) existing[field] = incomingValue;
}

export function copyMissingEvidence(existing: DedupFinding, incoming: TaggedFinding): void {
  fillOnlyIfAbsent(existing, incoming, "evidence");
}

export function copyMissingSuggestion(existing: DedupFinding, incoming: TaggedFinding): void {
  fillOnlyIfAbsent(existing, incoming, "suggestion");
}

export function copyMissingTraceId(existing: DedupFinding, incoming: TaggedFinding): void {
  fillOnlyIfAbsent(existing, incoming, "trace_id");
}

export function mergeRequirementIds(existing: DedupFinding, incoming?: string[]): void {
  if (!incoming?.length) return;
  existing.covers_requirement_ids = [
    ...new Set([...(existing.covers_requirement_ids ?? []), ...incoming]),
  ];
}

export function toDedupFinding(finding: TaggedFinding): DedupFinding {
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

export function severityRank(s: Finding["severity"]): number {
  const ranks: Record<Finding["severity"], number> = {
    info: 0,
    low: 1,
    medium: 2,
    high: 3,
    critical: 4,
  };
  return ranks[s];
}
