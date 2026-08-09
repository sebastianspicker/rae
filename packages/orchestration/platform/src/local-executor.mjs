/** Purpose: execute hosted claims through RAE's existing sandboxed local agent worker. */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { agentDoctor } from "../../scripts/pipeline/lib/agent-executor.mjs";
import {
  loadExecutionProfile,
  resolveExecutionTier,
  resolveNodeCapabilities,
} from "../../scripts/pipeline/lib/execution-profile.mjs";
import { loadProjectMap } from "./project-map.mjs";

const WORKER = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../scripts/pipeline/workflow-agent-worker.mjs",
);
const MAX_CHILD_OUTPUT = 16 * 1024 * 1024;
const SAFE_ID = /^[A-Za-z0-9._-]{1,128}$/;

function claimRequest(claim, projects) {
  if (
    !SAFE_ID.test(claim.runId) ||
    !SAFE_ID.test(claim.attemptId) ||
    !SAFE_ID.test(claim.nodeKey) ||
    !["read", "write"].includes(claim.access)
  )
    throw new Error("claim identity or access contract is invalid");
  const project = projects.get(claim.projectId);
  if (!project) throw new Error("claim project is not mapped on this worker");
  const payload = claim.payload;
  if (
    !payload ||
    typeof payload !== "object" ||
    typeof payload.prompt !== "string" ||
    Buffer.byteLength(payload.prompt) > 256 * 1024 ||
    !payload.outputSchema ||
    typeof payload.outputSchema !== "object" ||
    Array.isArray(payload.outputSchema)
  )
    throw new Error("claim payload must contain a bounded prompt and outputSchema object");
  const loaded = loadExecutionProfile(project.profile);
  if (loaded.profile.schema_version !== "2.0.0" || payload.profileDigest !== loaded.digest)
    throw new Error("claim does not match the worker's snapshotted execution profile");
  if (!Object.hasOwn(loaded.profile.node_capability_sets, claim.nodeKey))
    throw new Error("claim node is absent from the execution profile's exact capability map");
  const execution = resolveExecutionTier(loaded.profile, payload.tier || "standard");
  const capabilities = resolveNodeCapabilities(loaded.profile, claim.nodeKey);
  const attemptRoot = path.join(
    project.root,
    ".pipeline",
    "hosted-worker",
    claim.runId,
    claim.attemptId,
  );
  fs.mkdirSync(attemptRoot, { recursive: true, mode: 0o700 });
  const schemaPath = path.join(attemptRoot, "output.schema.json");
  const outputPath = path.join(attemptRoot, "output.json");
  const eventLogPath = path.join(attemptRoot, "events.jsonl");
  fs.writeFileSync(schemaPath, `${JSON.stringify(payload.outputSchema)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  return {
    project,
    request: {
      provider: "codex",
      phase: claim.nodeKey,
      runId: claim.runId,
      workspaceRoot: project.root,
      schemaPath,
      outputPath,
      eventLogPath,
      prompt: payload.prompt,
      sandboxMode: claim.access === "write" ? "workspace-write" : "read-only",
      model: execution.model,
      reasoningEffort: execution.reasoning_effort,
      capabilities,
      timeoutMs: Math.min(Math.max(Number(payload.timeoutSeconds || 1800), 60), 7200) * 1000,
    },
  };
}

export function createLocalClaimExecutor({ projectMapFile }) {
  const projects = loadProjectMap(projectMapFile);
  return (claim, signal) =>
    new Promise((resolve, reject) => {
      let prepared;
      try {
        prepared = claimRequest(claim, projects);
      } catch (error) {
        reject(error);
        return;
      }
      const child = spawn(process.execPath, [WORKER], {
        cwd: prepared.project.root,
        env: process.env,
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let settled = false;
      let killTimer = null;
      const processTarget = process.platform === "win32" ? child.pid : -child.pid;
      const terminate = () => {
        if (settled) return;
        try {
          process.kill(processTarget, "SIGTERM");
        } catch {
          return;
        }
        killTimer ??= setTimeout(() => {
          if (!settled)
            try {
              process.kill(processTarget, "SIGKILL");
            } catch {
              /* child already exited */
            }
        }, 2000);
      };
      signal?.addEventListener("abort", terminate, { once: true });
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
        if (Buffer.byteLength(stdout) > MAX_CHILD_OUTPUT) terminate();
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
        if (Buffer.byteLength(stderr) > MAX_CHILD_OUTPUT) terminate();
      });
      child.once("error", reject);
      child.once("close", (code) => {
        settled = true;
        if (killTimer) clearTimeout(killTimer);
        signal?.removeEventListener("abort", terminate);
        if (signal?.aborted) {
          reject(new Error("hosted claim execution aborted after lease loss"));
          return;
        }
        if (code !== 0) {
          reject(
            new Error(`local agent worker exited with status ${code}: ${stderr.slice(-1000)}`),
          );
          return;
        }
        try {
          const result = JSON.parse(stdout);
          resolve({
            artifact: result.artifact,
            durationMs: result.durationMs,
            resource_usage: result.resourceUsage,
            capability_surface: result.capabilitySurface,
            credential_manifest: result.credentialManifest,
            command_evidence: result.commandEvents,
          });
        } catch (error) {
          reject(new Error(`local agent worker returned invalid JSON: ${error.message}`));
        }
      });
      child.stdin.end(JSON.stringify(prepared.request));
    });
}

export function doctorLocalClaimExecutor({ projectMapFile }) {
  const projects = loadProjectMap(projectMapFile);
  const surfaces = [];
  for (const [projectId, project] of projects) {
    const loaded = loadExecutionProfile(project.profile);
    if (loaded.profile.schema_version !== "2.0.0")
      throw new Error(`project ${projectId} must use execution profile v2`);
    for (const [name, capabilities] of Object.entries(loaded.profile.capability_sets)) {
      const report = agentDoctor({
        provider: "codex",
        capabilities: { name, ...capabilities },
        workspaceRoot: project.root,
      });
      if (!report.success)
        throw new Error(`project ${projectId} capability set ${name} failed agent doctor`);
      surfaces.push({ projectId, capabilitySet: name, effectiveSurface: report.effective_surface });
    }
  }
  return surfaces;
}
