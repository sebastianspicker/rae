/** Verifies scheduler isolation, resumability, and opt-in bounded context behavior. */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, test } from "node:test";
import { mergeResumeOptions, savedAgentOptions } from "../src/run/autonomous-lifecycle.mjs";
import {
  BOUNDED_CONTEXT_BYTES,
  BoundedContextOverflowError,
  assembleBoundedWorkflowContext,
  contextPolicyDigest,
  contextPolicySnapshot,
} from "../src/workflow/workflow-context-bounded.mjs";
import { canonicalJson, workflowDigest } from "../src/workflow/workflow-contract.mjs";
import {
  payloadValidatorForWorkflow,
  providerPromptForWorkflow,
} from "../src/workflow/workflow-runtime.mjs";
import { scheduleWorkflow } from "../src/workflow/workflow-scheduler.mjs";

const roots = [];
const defaultWorkflow = JSON.parse(
  readFileSync(
    resolve(import.meta.dirname, "../../../workflows/graph-native-default.workflow.json"),
  ),
);
const autonomousPath = resolve(import.meta.dirname, "../src/cli/autonomous.mjs");
const defaultWorkflowPath = resolve(
  import.meta.dirname,
  "../../../workflows/graph-native-default.workflow.json",
);
const fakeWorkflowAgent = resolve(import.meta.dirname, "fixtures/fake-workflow-agent.mjs");
const failingWorkflowAgent = resolve(import.meta.dirname, "fixtures/failing-workflow-agent.mjs");

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function runDirectory() {
  const root = mkdtempSync(resolve(tmpdir(), "rae-context-"));
  roots.push(root);
  mkdirSync(resolve(root, "workflow", "attempts"), { recursive: true });
  return root;
}

function gitRepository() {
  const root = mkdtempSync(resolve(tmpdir(), "rae-context-run-"));
  roots.push(root);
  writeFileSync(resolve(root, "README.md"), "# context fixture\n");
  execFileSync("git", ["init", "-q", root]);
  execFileSync("git", ["-C", root, "config", "user.name", "RAE Test"]);
  execFileSync("git", ["-C", root, "config", "user.email", "rae@example.invalid"]);
  execFileSync("git", ["-C", root, "add", "."]);
  execFileSync("git", ["-C", root, "commit", "-qm", "fixture"]);
  return root;
}

function digest(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function envelope21(overrides = {}) {
  const payload = overrides.payload ?? { status: "passed" };
  const envelope = {
    schema_version: "2.1.0",
    run_id: "bounded-context-test",
    workflow_digest: "a".repeat(64),
    node_id: "mapped",
    instance_id: "mapped:item-a",
    parent_node: "source",
    item_key: "item-a",
    item_digest: "b".repeat(64),
    attempt: 2,
    loop_iteration: 3,
    status: "passed",
    failure: null,
    payload,
    findings: overrides.findings ?? [],
    evidence_refs: [],
    ownership: {},
    changed_paths: [],
    command_evidence: [],
    resource_usage: {},
    input_digest: "c".repeat(64),
    output_digest: "",
    execution_tier: "standard",
    selection: null,
    quorum: null,
    convergence: null,
    ...overrides,
  };
  envelope.output_digest =
    overrides.output_digest ??
    digest({
      payload: envelope.payload,
      findings: envelope.findings,
      evidence_refs: envelope.evidence_refs,
      ownership: envelope.ownership,
      changed_paths: envelope.changed_paths,
      command_evidence: envelope.command_evidence,
      resource_usage: envelope.resource_usage,
      selection: envelope.selection,
      quorum: envelope.quorum,
      convergence: envelope.convergence,
    });
  return envelope;
}

function persist21(runDir, envelope) {
  const directory = resolve(runDir, "workflow", "attempts", envelope.node_id);
  mkdirSync(directory, { recursive: true });
  const instance = envelope.instance_id.replaceAll(/[^a-zA-Z0-9._-]/g, "_");
  writeFileSync(
    resolve(directory, `${instance}.${envelope.attempt}.json`),
    `${JSON.stringify(envelope, null, 2)}\n`,
  );
}

test("bounded context is byte-deterministic for Unicode and records measured assembly evidence", () => {
  const arguments_ = {
    task: `Inspect ${"🧭".repeat(100)}`,
    node: { id: "inspect", guidance: "Read the supplied evidence." },
    item: { id: "α", label: "日本語" },
    inputs: [],
  };
  const first = assembleBoundedWorkflowContext({ ...arguments_, now: () => 10 });
  const second = assembleBoundedWorkflowContext({ ...arguments_, now: () => 25 });
  assert.deepEqual(first.prompt_context, second.prompt_context);
  assert.equal(first.digest, second.digest);
  assert.equal(
    first.manifest.assembled_bytes,
    Buffer.byteLength(canonicalJson(first.prompt_context)),
  );
  assert.ok(first.manifest.assembled_bytes <= BOUNDED_CONTEXT_BYTES);
  assert.equal(first.evidence.assembly_duration_ms, 0);
  assert.equal(first.manifest.reference_count, 0);
});

test("bounded provider prompt transmits the measured canonical context exactly once", () => {
  const workspaceRoot = gitRepository();
  const runId = "bounded-prompt-test";
  const runDir = resolve(workspaceRoot, ".pipeline", "runs", runId);
  mkdirSync(runDir, { recursive: true });
  const task = `TASK-UNIQUE:${"🧭".repeat(27_000)}`;
  const node = {
    id: "mapped",
    kind: "map",
    role: "mapper",
    access: "read",
    guidance: `GUIDANCE-UNIQUE:${"界".repeat(3_000)}`,
  };
  const item = {
    id: "MAP-UNIQUE",
    nested: [{ label: "日本語", detail: "🙂".repeat(1_000) }],
  };
  const assembled = assembleBoundedWorkflowContext({ task, node, item, runDir });
  assert.ok(assembled.manifest.assembled_bytes > BOUNDED_CONTEXT_BYTES - 12 * 1024);

  const prompt = providerPromptForWorkflow(
    {
      contextMode: "bounded",
      workflow: { schema_version: "2.1.0" },
      workspaceRoot,
      runDir,
      runId,
      workflowDigest: "a".repeat(64),
      task,
    },
    node,
    [],
    item,
    assembled.prompt_context,
  );
  const contextHeader =
    "Bounded workflow context (canonical JSON; complete inline artifacts or immutable artifact references):\n";
  const contextStart = prompt.indexOf(contextHeader) + contextHeader.length;
  const contextEnd = prompt.indexOf("\n\nArtifact reference base:", contextStart);
  const transmittedContext = prompt.slice(contextStart, contextEnd);
  assert.equal(transmittedContext, canonicalJson(assembled.prompt_context));
  assert.equal(Buffer.byteLength(transmittedContext, "utf8"), assembled.manifest.assembled_bytes);
  for (const marker of ["TASK-UNIQUE", "GUIDANCE-UNIQUE", "MAP-UNIQUE"]) {
    assert.equal(prompt.split(marker).length - 1, 1);
  }
  assert.equal(prompt.includes("User task:\n"), false);
  assert.equal(prompt.includes("Mapped item:\n"), false);
  assert.equal(prompt.includes("Node guidance:\n"), false);
  assert.match(prompt, /Artifact reference base: \.pipeline\/runs\/bounded-prompt-test\//);
  assert.match(prompt, /Resolve every artifact_ref relative to this run directory/);
});

test("bounded assembly evidence is durable before a failing provider runs", () => {
  const root = gitRepository();
  const failed = spawnSync(
    process.execPath,
    [
      autonomousPath,
      "run",
      "--project-root",
      root,
      "--task",
      "Capture bounded context before provider failure.",
      "--provider",
      "command",
      "--agent-command",
      process.execPath,
      "--agent-arg",
      failingWorkflowAgent,
      "--allow-unsafe-command-provider",
      "--workflow",
      defaultWorkflowPath,
      "--context-mode",
      "bounded",
      "--through",
      "requirements",
      "--in-place",
      "--json",
    ],
    { encoding: "utf8" },
  );
  assert.equal(failed.status, 1);
  assert.match(`${failed.stdout}\n${failed.stderr}`, /intentional workflow provider failure/);

  const [runId] = readdirSync(resolve(root, ".pipeline", "runs"));
  const artifactPath = resolve(
    root,
    ".pipeline",
    "runs",
    runId,
    "workflow",
    "context-assemblies",
    "requirements",
    "requirements.loop-1.attempt-1.json",
  );
  const record = JSON.parse(readFileSync(artifactPath, "utf8"));
  const serializedContext = canonicalJson(record.assembly.prompt_context);
  assert.equal(record.run_id, runId);
  assert.equal(record.context_mode, "bounded");
  assert.equal(
    record.context_assembly_ref,
    "workflow/context-assemblies/requirements/requirements.loop-1.attempt-1.json",
  );
  assert.equal(record.artifact_reference_base, `.pipeline/runs/${runId}/`);
  assert.equal(record.byte_metrics.assembled_bytes, Buffer.byteLength(serializedContext, "utf8"));
  assert.equal(record.byte_metrics.provider_context_bytes, record.byte_metrics.assembled_bytes);
  assert.ok(record.byte_metrics.provider_prompt_bytes > record.byte_metrics.provider_context_bytes);
  assert.equal(
    record.context_digest,
    digest({
      policy: contextPolicySnapshot("bounded"),
      prompt_context: record.assembly.prompt_context,
    }),
  );
  assert.equal(
    record.prompt_context_digest,
    createHash("sha256").update(serializedContext).digest("hex"),
  );
  assert.match(record.prompt_digest, /^[a-f0-9]{64}$/);
});

test("oversized predecessors use the verified retry, loop, and map attempt reference", () => {
  const runDir = runDirectory();
  const predecessor = envelope21({
    payload: { body: "x".repeat(BOUNDED_CONTEXT_BYTES) },
    findings: [{ severity: "blocking", summary: "preserved by artifact" }],
  });
  persist21(runDir, predecessor);
  const assembled = assembleBoundedWorkflowContext({
    task: "Use the predecessor.",
    node: { id: "next", guidance: "Continue." },
    inputs: [{ edge: { from: "mapped", to: "next", type: "artifact" }, envelope: predecessor }],
    runDir,
    now: () => 1,
  });
  const reference = assembled.prompt_context.items.at(-1).reference;
  assert.equal(reference.artifact_ref, "workflow/attempts/mapped/mapped_item-a.2.json");
  assert.equal(reference.output_digest, predecessor.output_digest);
  assert.equal(assembled.manifest.reference_count, 1);
  assert.ok(assembled.manifest.referenced_bytes > BOUNDED_CONTEXT_BYTES);

  const persistedPath = resolve(runDir, reference.artifact_ref);
  const tampered = JSON.parse(readFileSync(persistedPath, "utf8"));
  tampered.attempt = 1;
  writeFileSync(persistedPath, `${JSON.stringify(tampered)}\n`);
  assert.throws(
    () =>
      assembleBoundedWorkflowContext({
        task: "Use the predecessor.",
        node: { id: "next", guidance: "Continue." },
        inputs: [{ edge: { from: "mapped", to: "next", type: "artifact" }, envelope: predecessor }],
        runDir,
      }),
    /does not match the scheduled input/,
  );

  tampered.attempt = 2;
  tampered.payload.body = `y${tampered.payload.body.slice(1)}`;
  writeFileSync(persistedPath, `${JSON.stringify(tampered)}\n`);
  assert.throws(
    () =>
      assembleBoundedWorkflowContext({
        task: "Use the predecessor.",
        node: { id: "next", guidance: "Continue." },
        inputs: [{ edge: { from: "mapped", to: "next", type: "artifact" }, envelope: tampered }],
        runDir,
      }),
    /does not match the scheduled input/,
  );
});

test("required task context overflow fails before scheduler provider execution", async () => {
  let providerCalls = 0;
  await assert.rejects(
    scheduleWorkflow({
      workflow: defaultWorkflow,
      runId: "overflow-test",
      contextMode: "bounded",
      task: "t".repeat(BOUNDED_CONTEXT_BYTES),
      execute: async () => {
        providerCalls++;
        return { payload: { status: "passed" } };
      },
    }),
    BoundedContextOverflowError,
  );
  assert.equal(providerCalls, 0);
});

test("scheduler caps readers, excludes writers, serializes resources, and uses fresh retries", async () => {
  let readers = 0;
  let writers = 0;
  let resourceUsers = 0;
  let maximumReaders = 0;
  let maximumResourceUsers = 0;
  const retrySessions = [];
  const attempts = new Map();
  const result = await scheduleWorkflow({
    workflow: defaultWorkflow,
    runId: "scheduler-coverage",
    maxConcurrency: 4,
    execute: async ({ node, sessionId }) => {
      const attempt = (attempts.get(node.id) ?? 0) + 1;
      attempts.set(node.id, attempt);
      if (node.id === "requirements" && attempt === 1) {
        retrySessions.push(sessionId);
        throw new Error("retry fixture");
      }
      if (node.id === "requirements") retrySessions.push(sessionId);
      if (node.access === "write") {
        assert.equal(readers, 0);
        assert.equal(writers, 0);
        writers++;
      } else {
        assert.equal(writers, 0);
        readers++;
        maximumReaders = Math.max(maximumReaders, readers);
      }
      if (node.resource) {
        resourceUsers++;
        maximumResourceUsers = Math.max(maximumResourceUsers, resourceUsers);
      }
      await new Promise((accept) => setTimeout(accept, 2));
      if (node.resource) resourceUsers--;
      if (node.access === "write") writers--;
      else readers--;
      return { payload: { status: "passed", findings: [] } };
    },
  });
  assert.equal(result.status, "completed");
  assert.equal(maximumReaders, 4);
  assert.equal(maximumResourceUsers, 1);
  assert.equal(retrySessions.length, 2);
  assert.equal(new Set(retrySessions).size, 2);
});

test("persisted scheduler progress resumes after a provider crash without replaying completed work", async () => {
  const runDir = runDirectory();
  await assert.rejects(
    scheduleWorkflow({
      workflow: defaultWorkflow,
      runId: "crash-resume",
      runDir,
      execute: async ({ node }) => {
        if (node.id === "design") throw new Error("simulated provider crash");
        return { payload: { status: "passed", findings: [] } };
      },
    }),
    /simulated provider crash/,
  );
  const completed = JSON.parse(
    readFileSync(resolve(runDir, "workflow", "attempts", "requirements", "1.1.json")),
  );
  let requirementsReplayed = false;
  const resumed = await scheduleWorkflow({
    workflow: defaultWorkflow,
    runId: "crash-resume",
    runDir,
    resumeEnvelopes: [completed],
    execute: async ({ node }) => {
      if (node.id === "requirements") requirementsReplayed = true;
      return { payload: { status: "passed", findings: [] } };
    },
  });
  assert.equal(resumed.status, "completed");
  assert.equal(requirementsReplayed, false);
});

test("context policy metadata defaults old requests to legacy and rejects resume conflicts", () => {
  const legacy = savedAgentOptions({});
  assert.equal(legacy["context-mode"], "legacy");
  assert.throws(
    () => mergeResumeOptions(legacy, { "context-mode": "bounded" }),
    /context mode is immutable/,
  );
  const policy = contextPolicySnapshot("bounded");
  const stored = savedAgentOptions({
    context_policy: { mode: "bounded", digest: contextPolicyDigest(policy), snapshot: policy },
  });
  assert.equal(mergeResumeOptions(stored, {})["context-mode"], "bounded");
});

test("autonomous run snapshots bounded policy metadata and rejects a conflicting resume", () => {
  const root = gitRepository();
  const run = JSON.parse(
    execFileSync(
      process.execPath,
      [
        autonomousPath,
        "run",
        "--project-root",
        root,
        "--task",
        "Inspect the context fixture.",
        "--provider",
        "command",
        "--agent-command",
        process.execPath,
        "--agent-arg",
        fakeWorkflowAgent,
        "--allow-unsafe-command-provider",
        "--workflow",
        defaultWorkflowPath,
        "--context-mode",
        "bounded",
        "--through",
        "requirements",
        "--in-place",
        "--json",
      ],
      { encoding: "utf8" },
    ),
  );
  const request = JSON.parse(
    readFileSync(resolve(root, ".pipeline", "runs", run.run_id, "request.json")),
  );
  assert.equal(request.context_policy.mode, "bounded");
  assert.equal(request.context_policy.snapshot.schema_version, "1.0.0");
  assert.equal(request.context_policy.digest, contextPolicyDigest(request.context_policy.snapshot));
  const envelope = JSON.parse(
    readFileSync(
      resolve(
        root,
        ".pipeline",
        "runs",
        run.run_id,
        "workflow",
        "attempts",
        "requirements",
        "1.1.json",
      ),
    ),
  );
  assert.ok(envelope.resource_usage.context_assembly.assembled_bytes > 0);
  assert.ok(envelope.resource_usage.context_assembly.assembly_duration_ms >= 0);
  assert.equal(
    envelope.resource_usage.context_assembly.provider_context_bytes,
    envelope.resource_usage.context_assembly.assembled_bytes,
  );
  assert.ok(
    envelope.resource_usage.context_assembly.provider_prompt_bytes >
      envelope.resource_usage.context_assembly.assembled_bytes,
  );

  const resumed = spawnSync(
    process.execPath,
    [
      autonomousPath,
      "resume",
      "--project-root",
      root,
      "--run-id",
      run.run_id,
      "--provider",
      "command",
      "--agent-command",
      process.execPath,
      "--agent-arg",
      fakeWorkflowAgent,
      "--allow-unsafe-command-provider",
      "--context-mode",
      "legacy",
      "--json",
    ],
    { encoding: "utf8" },
  );
  assert.equal(resumed.status, 1);
  assert.match(resumed.stderr, /context mode is immutable/);

  request.context_policy.digest = "0".repeat(64);
  writeFileSync(
    resolve(root, ".pipeline", "runs", run.run_id, "request.json"),
    `${JSON.stringify(request, null, 2)}\n`,
  );
  const tampered = spawnSync(
    process.execPath,
    [
      autonomousPath,
      "resume",
      "--project-root",
      root,
      "--run-id",
      run.run_id,
      "--provider",
      "command",
      "--agent-command",
      process.execPath,
      "--agent-arg",
      fakeWorkflowAgent,
      "--allow-unsafe-command-provider",
      "--context-mode",
      "bounded",
      "--json",
    ],
    { encoding: "utf8" },
  );
  assert.equal(tampered.status, 1);
  assert.match(tampered.stderr, /context policy digest does not match/);
});

test("workflow 2.0 legacy mode remains the default provider input contract", async () => {
  let observedContext = "unset";
  await scheduleWorkflow({
    workflow: defaultWorkflow,
    runId: "legacy-default",
    through: defaultWorkflow.entry_node,
    execute: async ({ context }) => {
      observedContext = context;
      return { payload: { status: "passed", findings: [] } };
    },
  });
  assert.equal(observedContext, null);
  assert.match(workflowDigest(defaultWorkflow), /^[a-f0-9]{64}$/);
});

test("payload validators compile lazily per contract and are reused by workflow identity", () => {
  const workflow = {
    payload_contracts: {
      first: { $id: "https://rae.local/duplicate-contract", type: "object" },
      second: { $id: "https://rae.local/duplicate-contract", type: "object" },
      unusedInvalid: { type: "not-a-json-schema-type" },
    },
  };
  const first = payloadValidatorForWorkflow(workflow, "first");
  assert.strictEqual(first, payloadValidatorForWorkflow(workflow, "first"));
  assert.equal(first({}), true);
  assert.equal(payloadValidatorForWorkflow(workflow, "second")({}), true);
});
