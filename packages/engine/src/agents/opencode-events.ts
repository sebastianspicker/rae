/** Normalizes OpenCode event streams and persists them after serialization. */
import { readFileSync, existsSync } from "node:fs";
import { replacePrivateFile } from "./agent-provider-runtime.js";
const MAX_EVENT_COUNT = 20_000,
  MAX_EVENT_LINE_BYTES = 1024 * 1024;

interface JsonObject extends Record<string, unknown> {}
interface NormalizedPart extends Record<string, unknown> {
  type: string | null;
}
interface NormalizedEvent extends Record<string, unknown> {
  type: string;
  part: NormalizedPart;
}
function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function normalizedEvent(event: unknown): NormalizedEvent {
  const normalized: NormalizedEvent = { type: eventType(event), part: normalizedPart(null) };
  if (isJsonObject(event) && Number.isSafeInteger(event.timestamp)) {
    normalized.timestamp = event.timestamp;
  }
  normalized.part = normalizedPart(isJsonObject(event) ? event.part : undefined);
  return normalized;
}
function eventType(event: unknown): string {
  return isJsonObject(event) && typeof event.type === "string" ? event.type : "unknown";
}
function normalizedPart(value: unknown): NormalizedPart {
  const part: JsonObject = isJsonObject(value) ? value : {};
  const normalized: NormalizedPart = { type: typeof part.type === "string" ? part.type : null };
  if (typeof part.tool === "string") normalized.tool = part.tool;
  if (isJsonObject(part.state) && typeof part.state.status === "string") {
    normalized.status = part.state.status;
  }
  if (typeof part.text === "string") normalized.text_bytes = Buffer.byteLength(part.text);
  return normalized;
}
function validateFinalArtifact(texts: string[]): JsonObject {
  if (texts.length !== 1)
    throw new Error(`OpenCode must emit exactly one final text artifact; received ${texts.length}`);
  let artifact: unknown;
  try {
    artifact = JSON.parse(texts[0]?.trim() ?? "");
  } catch (error) {
    throw new Error(
      `OpenCode returned invalid final JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!artifact || typeof artifact !== "object" || Array.isArray(artifact))
    throw new Error("OpenCode final artifact must be a JSON object");
  return artifact as JsonObject;
}
function collectEvents(lines: string[]): { events: NormalizedEvent[]; texts: string[] } {
  const events: NormalizedEvent[] = [],
    texts: string[] = [];
  for (const [index, line] of lines.entries()) {
    if (Buffer.byteLength(line) > MAX_EVENT_LINE_BYTES)
      throw new Error(`OpenCode event ${index + 1} exceeds the line limit`);
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch (error) {
      throw new Error(
        `OpenCode event stream is invalid at line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    events.push(normalizedEvent(event));
    if (
      isJsonObject(event) &&
      event.type === "text" &&
      isJsonObject(event.part) &&
      typeof event.part.text === "string"
    ) {
      texts.push(event.part.text);
    }
    if (isJsonObject(event) && event.type === "error") {
      throw new Error("OpenCode emitted a terminal error event");
    }
  }
  return { events, texts };
}
interface EventLogContext {
  authorizedRoot: string;
  eventLogPath: string;
}
export function parseEvents(
  raw: unknown,
  eventLogContext?: EventLogContext | null,
): {
  artifact: JsonObject;
  eventCount: number;
} {
  const lines = String(raw ?? "")
    .split("\n")
    .filter((line) => line.trim());
  if (lines.length < 1 || lines.length > MAX_EVENT_COUNT)
    throw new Error("OpenCode emitted an invalid event count");
  const { events, texts } = collectEvents(lines);
  const body = `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
  if (eventLogContext && typeof eventLogContext === "object")
    replacePrivateFile({
      authorizedRoot: eventLogContext.authorizedRoot,
      destination: eventLogContext.eventLogPath,
      body,
    });
  return { artifact: validateFinalArtifact(texts), eventCount: events.length };
}
export function brokerEvidence(
  runtime: { evidencePath: string },
  phase: string,
): Array<Record<string, unknown>> {
  if (!existsSync(runtime.evidencePath)) return [];
  return readFileSync(runtime.evidencePath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .map((entry: JsonObject) => ({
      verification_id: entry.verification_id,
      command: `verification:${entry.verification_id}`,
      working_directory: ".",
      phase,
      exit_code: entry.exit_code,
      successful: entry.successful,
      argv_digest: entry.argv_digest,
    }));
}
