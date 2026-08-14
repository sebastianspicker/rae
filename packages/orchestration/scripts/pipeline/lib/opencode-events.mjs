/** Normalizes OpenCode event streams and persists them after serialization. */
import { readFileSync, existsSync } from "node:fs";
import { replacePrivateFile } from "./agent-provider-runtime.mjs";
const MAX_EVENT_COUNT = 20_000,
  MAX_EVENT_LINE_BYTES = 1024 * 1024;
function normalizedEvent(event) {
  const normalized = { type: eventType(event) };
  if (Number.isSafeInteger(event?.timestamp)) normalized.timestamp = event.timestamp;
  normalized.part = normalizedPart(event?.part);
  return normalized;
}
function eventType(event) {
  return typeof event?.type === "string" ? event.type : "unknown";
}
function normalizedPart(value) {
  const part = value && typeof value === "object" ? value : {};
  const normalized = { type: typeof part.type === "string" ? part.type : null };
  if (typeof part.tool === "string") normalized.tool = part.tool;
  if (typeof part.state?.status === "string") normalized.status = part.state.status;
  if (typeof part.text === "string") normalized.text_bytes = Buffer.byteLength(part.text);
  return normalized;
}
function validateFinalArtifact(texts) {
  if (texts.length !== 1)
    throw new Error(`OpenCode must emit exactly one final text artifact; received ${texts.length}`);
  let artifact;
  try {
    artifact = JSON.parse(texts[0].trim());
  } catch (error) {
    throw new Error(`OpenCode returned invalid final JSON: ${error.message}`);
  }
  if (!artifact || typeof artifact !== "object" || Array.isArray(artifact))
    throw new Error("OpenCode final artifact must be a JSON object");
  return artifact;
}
function collectEvents(lines) {
  const events = [],
    texts = [];
  for (const [index, line] of lines.entries()) {
    if (Buffer.byteLength(line) > MAX_EVENT_LINE_BYTES)
      throw new Error(`OpenCode event ${index + 1} exceeds the line limit`);
    let event;
    try {
      event = JSON.parse(line);
    } catch (error) {
      throw new Error(`OpenCode event stream is invalid at line ${index + 1}: ${error.message}`);
    }
    events.push(normalizedEvent(event));
    if (event?.type === "text" && typeof event.part?.text === "string") texts.push(event.part.text);
    if (event?.type === "error") throw new Error("OpenCode emitted a terminal error event");
  }
  return { events, texts };
}
export function parseEvents(raw, eventLogContext) {
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
export function brokerEvidence(runtime, phase) {
  if (!existsSync(runtime.evidencePath)) return [];
  return readFileSync(runtime.evidencePath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .map((entry) => ({
      verification_id: entry.verification_id,
      command: `verification:${entry.verification_id}`,
      working_directory: ".",
      phase,
      exit_code: entry.exit_code,
      successful: entry.successful,
      argv_digest: entry.argv_digest,
    }));
}
