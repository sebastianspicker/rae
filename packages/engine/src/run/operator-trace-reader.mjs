/** Incremental, bounded sanitized trace replay. Cached prefixes are content-verified on change. */
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { badTrace } from "../primitives/errors.mjs";
import { ensureRuntimeStateReadable } from "./runtime-state-guard.mjs";
import { getTracePath, MAX_TRACE_EVENTS } from "./trace.mjs";

const cache = new Map();
const MAX_CACHE_BYTES = 16 * 1024 * 1024;
const MAX_ENTRY_BYTES = 4 * 1024 * 1024;
const metrics = { bytes_read: 0, records_parsed: 0, cache_hits: 0 };
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const identity = (stat) => `${stat.dev}:${stat.ino}`;
const revision = (stat) => `${identity(stat)}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;

export function operatorTraceMetrics({ reset = false } = {}) {
  const result = { ...metrics, cache_entries: cache.size };
  if (reset) for (const key of Object.keys(metrics)) metrics[key] = 0;
  return result;
}

export function clearOperatorTraceCache() {
  cache.clear();
}

function retain(path, entry) {
  cache.delete(path);
  if (entry.bytes > MAX_ENTRY_BYTES) return;
  cache.set(path, entry);
  let total = [...cache.values()].reduce((sum, value) => sum + value.bytes, 0);
  while (cache.size > 16 || total > MAX_CACHE_BYTES) {
    const oldest = cache.keys().next().value;
    total -= cache.get(oldest).bytes;
    cache.delete(oldest);
  }
}

function project(line, runId, seq) {
  let record;
  try {
    metrics.records_parsed += 1;
    record = JSON.parse(line);
  } catch (error) {
    throw badTrace(`corrupt trace JSONL at line ${seq}: ${String(error)}`);
  }
  const event = {
    seq,
    event_id: typeof record?.event_id === "string" ? record.event_id : `${runId}:${seq}`,
  };
  for (const key of [
    "run_id",
    "ts",
    "event",
    "phase",
    "status",
    "tier",
    "artifact_ref",
    "gate_id",
  ]) {
    if (typeof record?.[key] === "string") event[key] = record[key];
  }
  return event;
}

function parseAppend(raw, prior, runId, stat) {
  // Growth alone is not proof of append-only writes: verify every committed byte.
  const reusable =
    prior &&
    prior.identity === identity(stat) &&
    raw.length >= prior.offset &&
    digest(raw.subarray(0, prior.offset)) === prior.digest;
  const events = reusable ? [...prior.events] : [];
  let lineNumber = reusable ? prior.lines : 0;
  let offset = reusable ? prior.offset : 0;
  for (;;) {
    const end = raw.indexOf(10, offset);
    if (end < 0) break; // The writer has not committed the final JSONL record yet.
    const line = raw.subarray(offset, end).toString("utf8").trim();
    offset = end + 1;
    lineNumber += 1;
    if (!line) continue;
    events.push(project(line, runId, lineNumber));
    if (events.length > MAX_TRACE_EVENTS) {
      throw badTrace(`trace file exceeds MAX_TRACE_EVENTS (${MAX_TRACE_EVENTS})`);
    }
  }
  return {
    identity: identity(stat),
    revision: revision(stat),
    offset,
    lines: lineNumber,
    digest: digest(raw.subarray(0, offset)),
    events,
    bytes: Buffer.byteLength(JSON.stringify(events)),
  };
}

function readSnapshot(path, runId) {
  const stat = statSync(path, { bigint: true });
  const prior = cache.get(path);
  if (prior?.revision === revision(stat)) {
    metrics.cache_hits += 1;
    retain(path, prior);
    return prior;
  }
  cache.delete(path);
  const raw = readFileSync(path);
  metrics.bytes_read += raw.length;
  const after = statSync(path, { bigint: true });
  if (revision(stat) !== revision(after))
    throw badTrace("trace changed while reading; retry replay");
  const entry = parseAppend(raw, prior, runId, stat);
  retain(path, entry);
  return entry;
}

/** Physical JSONL line cursors survive reconnects; returned records cannot mutate the cache. */
export function readOperatorEventsAfter(runId, root, { after = 0, limit = 100 } = {}) {
  if (
    !Number.isSafeInteger(after) ||
    after < 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > MAX_TRACE_EVENTS
  ) {
    throw badTrace("invalid operator event cursor or limit");
  }
  ensureRuntimeStateReadable(root, { expectedRunId: runId });
  const path = getTracePath(runId, root);
  let records;
  try {
    records = readSnapshot(path, runId).events;
  } catch (error) {
    cache.delete(path);
    if (error.code !== "ENOENT") throw error;
    records = [];
  }
  ensureRuntimeStateReadable(root, { expectedRunId: runId });
  // Binary search avoids scanning retained history for every page.
  let low = 0;
  let high = records.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (records[middle].seq <= after) low = middle + 1;
    else high = middle;
  }
  const events = records.slice(low, low + limit).map((event) => ({ ...event }));
  return {
    events,
    next_after: events.at(-1)?.seq ?? after,
    has_more: low + events.length < records.length,
  };
}
