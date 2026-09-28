#!/usr/bin/env node
/** Owns one async proposal provider lifecycle for the synchronous proposal facade. */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runAgentPhase, type AgentProvider } from "../agents/agent-executor.js";
import { redact } from "../agents/agent-provider-runtime.js";
import type { CapabilitySet } from "./execution-profile.js";
import { contractsRoot } from "../primitives/installation-paths.js";

const MAX_REQUEST_BYTES = 512 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;

interface ProposalExecutionRoute extends Record<string, unknown> {
  executor?: AgentProvider;
  model?: string;
  reasoning_effort?: string;
  variant?: string;
  capabilities?: CapabilitySet;
}

export interface ProposalHelperRequest {
  projectRoot: string;
  prompt: string;
  temporary: string;
  attempt: 1 | 2;
  execution: ProposalExecutionRoute | null;
}

interface ProposalHelperResponse {
  success: true;
  artifact: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requiredString(record: Record<string, unknown>, key: string, maxBytes: number): string {
  const value = record[key];
  if (typeof value !== "string" || !value || Buffer.byteLength(value, "utf8") > maxBytes) {
    throw new Error(`proposal helper ${key} is invalid`);
  }
  return value;
}

export function parseProposalHelperRequest(value: unknown): ProposalHelperRequest {
  if (!isRecord(value)) throw new Error("proposal helper request must be an object");
  const attempt = value.attempt;
  if (attempt !== 1 && attempt !== 2) throw new Error("proposal helper attempt must be 1 or 2");
  const executionValue = value.execution;
  if (executionValue !== null && executionValue !== undefined && !isRecord(executionValue)) {
    throw new Error("proposal helper execution route must be an object or null");
  }
  const execution = (executionValue ?? null) as ProposalExecutionRoute | null;
  if (
    execution?.executor !== undefined &&
    execution.executor !== "codex" &&
    execution.executor !== "opencode"
  ) {
    throw new Error("proposal helper executor must be codex or opencode");
  }
  return {
    projectRoot: requiredString(value, "projectRoot", 16 * 1024),
    prompt: requiredString(value, "prompt", 256 * 1024),
    temporary: requiredString(value, "temporary", 16 * 1024),
    attempt,
    execution,
  };
}

export async function executeProposalHelperRequest(
  request: ProposalHelperRequest,
): Promise<ProposalHelperResponse> {
  const { projectRoot, prompt, temporary, attempt, execution } = request;
  const result = await runAgentPhase({
    provider: execution?.executor ?? "codex",
    phase: `workflow-proposal-${attempt}`,
    runId: `proposal-${process.pid}`,
    workspaceRoot: projectRoot,
    schemaPath: resolve(contractsRoot, "workflows/workflow-v2.1.schema.json"),
    outputPath: resolve(temporary, `proposal-${attempt}.json`),
    eventLogPath: resolve(temporary, `proposal-${attempt}.events.jsonl`),
    eventLogRoot: temporary,
    prompt,
    sandboxMode: "read-only",
    model: execution?.model,
    reasoningEffort: execution?.reasoning_effort,
    variant: execution?.variant,
    capabilities: execution?.capabilities,
    sourceRoot: projectRoot,
    inPlace: true,
    timeoutMs: 30 * 60 * 1000,
  });
  return { success: true, artifact: result.artifact };
}

async function readBoundedStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const value of process.stdin) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
    bytes += chunk.length;
    if (bytes > MAX_REQUEST_BYTES) throw new Error("proposal helper request exceeds size limit");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<void> {
  try {
    const raw = await readBoundedStdin();
    const request = parseProposalHelperRequest(JSON.parse(raw) as unknown);
    const response = await executeProposalHelperRequest(request);
    const body = `${JSON.stringify(response)}\n`;
    if (Buffer.byteLength(body, "utf8") > MAX_RESPONSE_BYTES) {
      throw new Error("proposal helper response exceeds size limit");
    }
    process.stdout.write(body);
  } catch (error) {
    process.exitCode = 1;
    const message = redact(error instanceof Error ? error.message : String(error));
    process.stdout.write(`${JSON.stringify({ success: false, error: { message } })}\n`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  await main();
}
