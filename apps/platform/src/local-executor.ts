/** Execute hosted claims through the public engine supervisor and private staging. */
import {
  agentDoctor,
  loadExecutionProfile,
  resolveNodeCapabilities,
  runAgentPhase,
  type AgentPhaseOptions,
} from "@rae/engine";
import { z } from "zod";
import { loadProjectMap } from "./project-map.js";
import { prepareHostedAttempt } from "./attempt-runtime.js";
import { createHostedStaging } from "./hosted-staging.js";
import type { Claim } from "./store-types.js";

export { prepareHostedAttempt } from "./attempt-runtime.js";
const safeId = z.string().regex(/^[A-Za-z0-9._-]{1,128}$/);
const claimContract = z.object({
  runId: safeId,
  attemptId: safeId,
  nodeKey: safeId,
  projectId: safeId,
  access: z.enum(["read", "write"]),
  payload: z.object({
    prompt: z.string().refine((value) => Buffer.byteLength(value) <= 256 * 1024),
    outputSchema: z.record(z.string(), z.unknown()),
    profileDigest: z.string(),
    tier: z.enum(["economy", "standard", "judgment"]).default("standard"),
    timeoutSeconds: z.number().finite().optional(),
  }),
});
type Projects = ReturnType<typeof loadProjectMap>;
interface ExecutorOptions {
  projectMapFile: string;
}
/** Explicit dependencies permit containment and cancellation tests without a real provider. */
export interface ExecutorDependencies {
  loadProjects: typeof loadProjectMap;
  loadProfile: typeof loadExecutionProfile;
  run: typeof runAgentPhase;
  stage: typeof createHostedStaging;
}
const defaults: ExecutorDependencies = {
  loadProjects: loadProjectMap,
  loadProfile: loadExecutionProfile,
  run: runAgentPhase,
  stage: createHostedStaging,
};
function prepareRequest(
  claimValue: Claim,
  projects: Projects,
  loadProfile: typeof loadExecutionProfile,
) {
  const claim = claimContract.parse(claimValue);
  const project = projects.get(claim.projectId);
  if (!project) throw new Error("claim project is not mapped on this worker");
  const { payload } = claim;
  const loaded = loadProfile(project.profile);
  if (loaded.profile.schema_version !== "2.0.0" || payload.profileDigest !== loaded.digest)
    throw new Error("claim does not match the worker's snapshotted execution profile");
  if (!Object.hasOwn(loaded.profile.node_capability_sets, claim.nodeKey))
    throw new Error("claim node is absent from the execution profile's exact capability map");
  const capabilities = resolveNodeCapabilities(loaded.profile, claim.nodeKey);
  if (!capabilities) throw new Error("hosted claims require an explicit capability set");
  const execution = loaded.profile.tiers[payload.tier];
  const runtime = prepareHostedAttempt(
    project.root,
    claim.runId,
    claim.attemptId,
    payload.outputSchema,
  );
  return { claim, project, capabilities, execution, runtime };
}

export function createLocalClaimExecutor(
  { projectMapFile }: ExecutorOptions,
  dependencies: ExecutorDependencies = defaults,
): (claim: Claim, signal: AbortSignal) => Promise<Record<string, unknown>> {
  const projects = dependencies.loadProjects(projectMapFile);
  const projectRoots = [...projects.values()].map((project) => project.root);
  return async (claimValue, signal) => {
    signal.throwIfAborted();
    const { claim, project, capabilities, execution, runtime } = prepareRequest(
      claimValue,
      projects,
      dependencies.loadProfile,
    );
    const staging = dependencies.stage(projectRoots);
    let failed = false;
    try {
      staging.writeSchema(Buffer.from(`${JSON.stringify(claim.payload.outputSchema)}\n`));
      runtime.assertIntact();
      signal.throwIfAborted();
      const request: AgentPhaseOptions = {
        provider: "codex",
        phase: claim.nodeKey,
        runId: claim.runId,
        workspaceRoot: project.root,
        schemaPath: staging.schemaPath,
        outputPath: staging.outputPath,
        eventLogPath: staging.eventLogPath,
        eventLogRoot: staging.root,
        prompt: claim.payload.prompt,
        sandboxMode: claim.access === "write" ? "workspace-write" : "read-only",
        model: execution.model,
        reasoningEffort: execution.reasoning_effort,
        capabilities,
        timeoutMs: Math.min(Math.max(claim.payload.timeoutSeconds || 1800, 60), 7200) * 1000,
        signal,
      };
      // The supervisor resolves or rejects only after its owned process group is terminated.
      const result = await dependencies.run(request);
      signal.throwIfAborted();
      runtime.assertIntact();
      const output = staging.read("output.json");
      const events = staging.read("events.jsonl");
      runtime.publishArtifact("output.json", output);
      runtime.publishArtifact("events.jsonl", events);
      return {
        artifact: result.artifact,
        durationMs: result.durationMs,
        resource_usage: result.resourceUsage,
        capability_surface: result.capabilitySurface,
        credential_manifest: result.credentialManifest,
        command_evidence: result.commandEvents,
      };
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      closeStaging(staging, failed);
    }
  };
}

function closeStaging(staging: ReturnType<typeof createHostedStaging>, failed: boolean): void {
  try {
    staging.close();
  } catch (error) {
    if (!failed) throw error;
    process.emitWarning("Hosted staging cleanup failed after execution failure", {
      code: "HOSTED_STAGING_CLEANUP_FAILED",
    });
  }
}

export function doctorLocalClaimExecutor({ projectMapFile }: ExecutorOptions) {
  const projects = loadProjectMap(projectMapFile);
  const surfaces: Array<{ projectId: string; capabilitySet: string; effectiveSurface: unknown }> =
    [];
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
