/** Strict run-bound cursors and byte-budgeted pages for hosted immutable events. */
export const DEFAULT_EVENT_LIMIT = 100;
export const MAX_EVENT_LIMIT = 1000;
export const MAX_EVENT_PAGE_BYTES = 2 * 1024 * 1024;
const maximumId = 9223372036854775807n;
export interface StoredEvent {
  id: number | string;
  oversized?: boolean;
  [key: string]: unknown;
}
export interface EventPage {
  events: StoredEvent[];
  nextCursor: string | null;
}
export interface EventPageStore {
  listRunEventsAfter(runId: string, after: string, limit: number): Promise<StoredEvent[]>;
}
export class EventPageError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string,
  ) {
    super(message);
  }
}
function invalid(message: string): never {
  throw new EventPageError(message, 400, "INVALID_EVENT_CURSOR");
}
function eventId(value: unknown): string {
  if (typeof value === "number" && (!Number.isSafeInteger(value) || value < 0))
    return invalid("Event cursor ID is outside the supported range");
  if (typeof value !== "string" && typeof value !== "number")
    return invalid("Invalid event cursor ID");
  const text = String(value);
  if (!/^(?:0|[1-9][0-9]{0,18})$/.test(text) || BigInt(text) > maximumId)
    return invalid("Invalid event cursor ID");
  return text;
}
export function eventLimit(value: unknown): number {
  if (value === undefined || value === null) return DEFAULT_EVENT_LIMIT;
  if (
    (typeof value !== "number" && typeof value !== "string") ||
    !/^[1-9][0-9]{0,3}$/.test(String(value))
  )
    throw new EventPageError(
      "Event limit must be an integer from 1 to 1000",
      400,
      "INVALID_EVENT_LIMIT",
    );
  const limit = Number(value);
  if (limit > MAX_EVENT_LIMIT)
    throw new EventPageError(
      "Event limit must be an integer from 1 to 1000",
      400,
      "INVALID_EVENT_LIMIT",
    );
  return limit;
}
export function encodeEventCursor(runId: string, after: number | string): string {
  return Buffer.from(JSON.stringify({ v: 1, run: runId, after: eventId(after) })).toString(
    "base64url",
  );
}
export function decodeEventCursor(runId: string, cursor: unknown): string {
  if (cursor === undefined || cursor === null) return "0";
  if (typeof cursor !== "string" || !/^[A-Za-z0-9_-]{1,512}$/.test(cursor))
    return invalid("Invalid event cursor");
  const bytes = Buffer.from(cursor, "base64url");
  if (bytes.toString("base64url") !== cursor) return invalid("Non-canonical event cursor");
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return invalid("Malformed event cursor");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    return invalid("Invalid event cursor");
  const fields = value as Record<string, unknown>;
  if (
    Object.keys(fields).sort().join(",") !== "after,run,v" ||
    fields.v !== 1 ||
    fields.run !== runId
  )
    return invalid("Event cursor does not belong to this run");
  return eventId(fields.after);
}
/** Preserve the existing stream's decimal IDs while refusing silent cursor resets. */
export function streamEventCursor(value: unknown): string {
  return value === undefined || value === null ? "0" : eventId(value);
}
export async function pageRunEvents(
  store: EventPageStore,
  runId: string,
  options: {
    cursor?: unknown;
    limit?: unknown;
    encoding?: {
      eventBytes: (serialized: string) => number;
      emptyPageBytes: (nextCursor: string | null) => number;
    };
  } = {},
): Promise<EventPage> {
  const after = decodeEventCursor(runId, options.cursor),
    limit = eventLimit(options.limit);
  const rows = await store.listRunEventsAfter(runId, after, limit);
  if (!Array.isArray(rows) || rows.length > limit)
    throw new EventPageError("Event store exceeded its page limit", 500, "INVALID_EVENT_PAGE");
  function checkedBytes(value: number): number {
    if (!Number.isSafeInteger(value) || value < 0)
      throw new EventPageError("Invalid event transport accounting", 500, "INVALID_EVENT_PAGE");
    return value;
  }
  function checkedId(event: StoredEvent, previous: string): string {
    let current: string;
    try {
      current = eventId(event?.id);
    } catch {
      throw new EventPageError("Event store returned an invalid ID", 500, "INVALID_EVENT_PAGE");
    }
    if (BigInt(current) <= BigInt(previous))
      throw new EventPageError(
        "Event store returned non-increasing IDs",
        500,
        "INVALID_EVENT_PAGE",
      );
    return current;
  }
  let previous = after;
  const ids = rows.map((event) => {
    previous = checkedId(event, previous);
    return previous;
  });
  let hasMore = false;
  if (rows.length) {
    const remaining = await store.listRunEventsAfter(runId, previous, 1);
    if (!Array.isArray(remaining) || remaining.length > 1)
      throw new EventPageError("Event store exceeded its page limit", 500, "INVALID_EVENT_PAGE");
    if (remaining.length) {
      checkedId(remaining[0], previous);
      hasMore = true;
    }
  }
  const events: StoredEvent[] = [];
  previous = after;
  let bytes = 0;
  const eventBytes =
    options.encoding?.eventBytes ?? ((serialized: string) => Buffer.byteLength(serialized));
  const emptyPageBytes =
    options.encoding?.emptyPageBytes ??
    ((nextCursor: string | null) => Buffer.byteLength(JSON.stringify({ events: [], nextCursor })));
  const framingBytes = (cursor: string | null) => checkedBytes(emptyPageBytes(cursor));
  for (const [index, event] of rows.entries()) {
    const current = ids[index];
    const nextCursor =
      index === rows.length - 1 && !hasMore ? null : encodeEventCursor(runId, current);
    const prefix = () => ({ events, nextCursor: encodeEventCursor(runId, previous) });
    if (event.oversized) {
      if (events.length) return prefix();
      throw new EventPageError(
        `Historical event ${current} exceeds the response byte budget`,
        422,
        "EVENT_TOO_LARGE",
      );
    }
    let serialized: string;
    try {
      serialized = JSON.stringify(event);
      if (typeof serialized !== "string") throw new Error("Event did not serialize to JSON");
    } catch {
      throw new EventPageError(
        `Historical event ${current} is not serializable`,
        500,
        "INVALID_HISTORICAL_EVENT",
      );
    }
    const encodedBytes = checkedBytes(eventBytes(serialized));
    const candidateBytes =
      framingBytes(nextCursor) + bytes + encodedBytes + (events.length ? 1 : 0);
    if (candidateBytes > MAX_EVENT_PAGE_BYTES) {
      if (events.length) return prefix();
      throw new EventPageError(
        `Historical event ${current} exceeds the response byte budget`,
        422,
        "EVENT_TOO_LARGE",
      );
    }
    bytes += encodedBytes + (events.length ? 1 : 0);
    events.push(event);
    previous = current;
  }
  const nextCursor = hasMore ? encodeEventCursor(runId, previous) : null;
  if (framingBytes(nextCursor) + bytes > MAX_EVENT_PAGE_BYTES)
    throw new EventPageError("Event transport exceeds byte budget", 500, "INVALID_EVENT_PAGE");
  return { events, nextCursor };
}
