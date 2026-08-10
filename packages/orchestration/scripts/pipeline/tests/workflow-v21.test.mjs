/** Verifies graph-native workflow contracts, scheduling, and private registry behavior. */
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, test } from "vitest";
import { validateWorkflow } from "../lib/workflow-contract.mjs";
import { scheduleWorkflow } from "../lib/workflow-scheduler.mjs";
import {
  assertExecutionProfileCoverage,
  credentialDigestManifest,
  executionProfileDigest,
  loadExecutionProfile,
  resolveNodeCapabilities,
  resolveExecutionTier,
  validateExecutionProfile,
} from "../lib/execution-profile.mjs";
import { applyWorkflowTransform, deduplicateDiscovery } from "../lib/workflow-transforms.mjs";

const defaultPath = resolve(
  import.meta.dirname,
  "../../../workflows/graph-native-default.workflow.json",
);
const autonomousPath = resolve(import.meta.dirname, "../autonomous.mjs");
const fakeWorkflowAgent = resolve(import.meta.dirname, "fixtures/fake-workflow-agent.mjs");

function temporaryRepository() {
  const root = mkdtempSync(resolve(tmpdir(), "rae-workflow-registry-"));
  execFileSync("git", ["init", "-q", root]);
  execFileSync("git", ["-C", root, "config", "user.name", "RAE Test"]);
  execFileSync("git", ["-C", root, "config", "user.email", "rae@example.invalid"]);
  writeFileSync(resolve(root, "README.md"), "fixture\n");
  execFileSync("git", ["-C", root, "add", "README.md"]);
  execFileSync("git", ["-C", root, "commit", "-qm", "fixture"]);
  return root;
}

function workflow21({ nodes, edges, entry = nodes[0].id, terminal = "complete" }) {
  return {
    schema_version: "2.1.0",
    workflow_id: "dynamic-test",
    revision: 1,
    entry_node: entry,
    terminal_node: terminal,
    nodes,
    edges,
    budgets: {
      max_concurrency: 4,
      max_repair_rounds: 5,
      max_attempts_per_node: 2,
      max_dynamic_instances: 128,
      max_pipeline_depth: 4,
      max_map_items: 32,
    },
  };
}

function integrationProfile() {
  return {
    schema_version: "1.0.0",
    profile_id: "integration-profile",
    tiers: {
      economy: { model: "economy-fixture", reasoning_effort: "low" },
      standard: { model: "standard-fixture", reasoning_effort: "medium" },
      judgment: { model: "judgment-fixture", reasoning_effort: "high" },
    },
  };
}

function runProfileWorkflow(root, profilePath) {
  const recipe = resolve(
    import.meta.dirname,
    "../../../workflows/recipes/cited-research.workflow.json",
  );
  return JSON.parse(
    execFileSync(
      process.execPath,
      [
        autonomousPath,
        "run",
        "--project-root",
        root,
        "--task",
        "Collect fixture claims.",
        "--provider",
        "command",
        "--agent-command",
        process.execPath,
        "--agent-arg",
        fakeWorkflowAgent,
        "--allow-unsafe-command-provider",
        "--workflow",
        recipe,
        "--execution-profile",
        profilePath,
        "--through",
        "claims",
        "--json",
      ],
      { encoding: "utf8" },
    ),
  );
}

function mappedWorkflow() {
  return workflow21({
    nodes: [
      { id: "source", kind: "agent", access: "read", guidance: "source" },
      {
        id: "mapped",
        kind: "map",
        access: "read",
        guidance: "map",
        map: { source_pointer: "/items", stable_key_pointer: "/id" },
      },
      { id: "verify", kind: "gate", access: "control", guidance: "verify", verification: true },
      { id: "complete", kind: "terminal", access: "control", guidance: "complete" },
    ],
    edges: [
      { from: "source", to: "mapped", type: "artifact" },
      { from: "mapped", to: "verify", type: "artifact" },
      { from: "verify", to: "complete", type: "condition", condition: "success" },
    ],
  });
}
describe("workflow v2 autonomous integration", () => {
  test("starts graph-native command fixtures only when an explicit workflow is selected", () => {
    const root = temporaryRepository();
    const output = JSON.parse(
      execFileSync(
        process.execPath,
        [
          autonomousPath,
          "run",
          "--project-root",
          root,
          "--task",
          "Inspect the fixture requirements.",
          "--provider",
          "command",
          "--agent-command",
          process.execPath,
          "--agent-arg",
          fakeWorkflowAgent,
          "--allow-unsafe-command-provider",
          "--workflow",
          defaultPath,
          "--through",
          "requirements",
          "--json",
        ],
        { encoding: "utf8" },
      ),
    );
    const runDir = resolve(output.workspace_root, ".pipeline", "runs", output.run_id);
    const request = JSON.parse(readFileSync(resolve(runDir, "request.json"), "utf8"));
    const snapshot = JSON.parse(readFileSync(resolve(runDir, "workflow", "snapshot.json"), "utf8"));
    expect(request.schema_version).toBe("2.0.0");
    expect(request.workflow.mode).toBe("graph-native");
    expect(snapshot.digest).toBe(request.workflow.digest);
    expect(
      readFileSync(resolve(runDir, "workflow", "attempts", "requirements", "1.1.json"), "utf8"),
    ).toContain('"node_id": "requirements"');
  });

  test("snapshots a logical execution profile and resolves the node tier", () => {
    const root = temporaryRepository();
    const profilePath = resolve(realpathSync(root), "execution-profile.json");
    const profile = integrationProfile();
    writeFileSync(profilePath, `${JSON.stringify(profile)}\n`);
    execFileSync("git", ["-C", root, "add", "execution-profile.json"]);
    execFileSync("git", ["-C", root, "commit", "-qm", "profile fixture"]);
    const output = runProfileWorkflow(root, profilePath);
    const runDir = resolve(output.workspace_root, ".pipeline", "runs", output.run_id);
    const request = JSON.parse(readFileSync(resolve(runDir, "request.json"), "utf8"));
    const envelope = JSON.parse(
      readFileSync(resolve(runDir, "workflow", "attempts", "claims", "claims.1.json"), "utf8"),
    );
    expect(request.execution_profile.digest).toBe(executionProfileDigest(profile));
    expect(request.execution_profile.snapshot).toEqual(profile);
    expect(envelope.schema_version).toBe("2.1.0");
    expect(envelope.execution_tier).toBe("standard");
  });
});

describe("workflow v2.1 contract and transforms", () => {
  test("accepts bounded maps and rejects executable fields and oversized stream depth", () => {
    const workflow = workflow21({
      nodes: [
        { id: "source", kind: "agent", access: "read", guidance: "source" },
        {
          id: "mapped",
          kind: "map",
          access: "read",
          guidance: "map",
          tier: "economy",
          map: { source_pointer: "/items", stable_key_pointer: "/id", max_items: 32 },
        },
        { id: "verify", kind: "gate", access: "control", guidance: "verify", verification: true },
        { id: "complete", kind: "terminal", access: "control", guidance: "complete" },
      ],
      edges: [
        { from: "source", to: "mapped", type: "artifact" },
        { from: "mapped", to: "verify", type: "artifact" },
        { from: "verify", to: "complete", type: "condition", condition: "success" },
      ],
    });
    expect(validateWorkflow(workflow).schema_version).toBe("2.1.0");
    workflow.payload_contracts = { unsafe: { type: "object", model: { type: "string" } } };
    expect(() => validateWorkflow(workflow)).toThrow(/forbidden key model/);
  });

  test("executes only deterministic allowlisted transforms", () => {
    const input = {
      items: [
        { id: "b", value: 2 },
        { id: "a", value: 1 },
        { id: "a", value: 3 },
      ],
    };
    expect(
      applyWorkflowTransform(
        { operation: "deduplicate", source_pointer: "/items", key_pointer: "/id" },
        input,
      ).map(({ id }) => id),
    ).toEqual(["b", "a"]);
    expect(
      applyWorkflowTransform(
        { operation: "sort", source_pointer: "/items", key_pointer: "/id" },
        input,
      ).map(({ id }) => id),
    ).toEqual(["a", "a", "b"]);
    expect(
      applyWorkflowTransform(
        { operation: "cartesian", pointers: ["/left", "/right"], limit: 4 },
        { left: [1, 2], right: ["a", "b"] },
      ),
    ).toEqual([
      [1, "a"],
      [1, "b"],
      [2, "a"],
      [2, "b"],
    ]);
    expect(deduplicateDiscovery([{ id: "seen" }, { id: "new" }], "/id", ["seen"])).toEqual({
      fresh: [{ id: "new" }],
      rejected: [{ id: "seen" }],
      seen_keys: ["new", "seen"],
      dry: false,
    });
  });

  test("loads an immutable logical-tier execution profile", () => {
    const root = mkdtempSync(resolve(tmpdir(), "rae-execution-profile-"));
    const path = resolve(realpathSync(root), "profile.json");
    const profile = {
      schema_version: "1.0.0",
      profile_id: "test-profile",
      tiers: {
        economy: { model: "codex-economy", reasoning_effort: "low" },
        standard: { model: "codex-standard", reasoning_effort: "medium" },
        judgment: { model: "codex-judgment", reasoning_effort: "high" },
      },
    };
    writeFileSync(path, `${JSON.stringify(profile)}\n`);
    const loaded = loadExecutionProfile(path);
    expect(loaded.digest).toBe(executionProfileDigest(profile));
    expect(resolveExecutionTier(loaded.profile, "judgment")).toMatchObject({
      tier: "judgment",
      model: "codex-judgment",
      reasoning_effort: "high",
    });
  });

  test("validates exact v2 node capabilities and declared credential digests", () => {
    const profile = {
      schema_version: "2.0.0",
      profile_id: "least-privilege-profile",
      tiers: {
        economy: { model: "codex-economy", reasoning_effort: "low" },
        standard: { model: "codex-standard", reasoning_effort: "medium" },
        judgment: { model: "codex-judgment", reasoning_effort: "high" },
      },
      capability_sets: {
        sealed: { web_search: "disabled", mcp_servers: [], credential_env_vars: [] },
        research: {
          web_search: "disabled",
          credential_env_vars: ["RESEARCH_MCP_TOKEN"],
          mcp_servers: [
            {
              name: "research",
              transport: "streamable-http",
              url: "https://mcp.example.invalid/rae",
              enabled_tools: ["lookup_claim"],
              token_env_var: "RESEARCH_MCP_TOKEN",
            },
          ],
        },
      },
      default_capability_set: "sealed",
      node_capability_sets: { source: "research", complete: "sealed" },
    };
    const workflow = {
      schema_version: "2.2.0",
      nodes: [{ id: "source" }, { id: "complete" }],
    };
    expect(validateExecutionProfile(profile)).toEqual(profile);
    expect(() => assertExecutionProfileCoverage(profile, workflow)).not.toThrow();
    expect(resolveNodeCapabilities(profile, "source")).toMatchObject({
      name: "research",
      web_search: "disabled",
    });
    expect(
      credentialDigestManifest(resolveNodeCapabilities(profile, "source"), {
        RESEARCH_MCP_TOKEN: "fixture-token",
      }),
    ).toEqual([
      {
        name: "RESEARCH_MCP_TOKEN",
        digest: "626a1d7ceeb7422fc2b8a6b83ae81af22f80edc6a4b7f519d9f15678935e57ec",
      },
    ]);
    expect(() =>
      assertExecutionProfileCoverage(profile, {
        schema_version: "2.2.0",
        nodes: [{ id: "source" }],
      }),
    ).toThrow(/extras: complete/);
    const queryCredential = structuredClone(profile);
    queryCredential.capability_sets.research.mcp_servers[0].url =
      "https://mcp.example.invalid/rae?token=forbidden";
    expect(() => validateExecutionProfile(queryCredential)).toThrow(/without a query or fragment/);
  });
});

describe("workflow v2.1 instance scheduler", () => {
  test("uses stable fan-out identities and reconstructs a partially completed map", async () => {
    const workflow = mappedWorkflow();
    const calls = [];
    const result = await scheduleWorkflow({
      workflow,
      runId: "map-test",
      execute: async ({ node, item, instance_id: instanceId }) => {
        calls.push(instanceId);
        return node.id === "source"
          ? {
              payload: {
                items: [
                  { id: "a", body: 1 },
                  { id: "b", body: 2 },
                ],
              },
            }
          : { payload: { status: "passed", item } };
      },
    });
    expect(result.status).toBe("completed");
    expect(calls.filter((id) => id.startsWith("mapped:"))).toHaveLength(2);
    const identities = [...result.completed.keys()].filter((id) => id.startsWith("mapped:"));
    const changed = structuredClone(workflow);
    const changedResult = await scheduleWorkflow({
      workflow: changed,
      runId: "map-test-2",
      execute: async ({ node }) =>
        node.id === "source"
          ? {
              payload: {
                items: [
                  { id: "a", body: 999 },
                  { id: "b", body: 2 },
                ],
              },
            }
          : { payload: { status: "passed" } },
    });
    expect([...changedResult.completed.keys()].filter((id) => id.startsWith("mapped:"))).toEqual(
      identities,
    );
    const resumedCalls = [];
    const resumed = await scheduleWorkflow({
      workflow,
      runId: "map-test",
      resumeEnvelopes: [result.completed.get("source"), result.completed.get(identities[0])],
      execute: async ({ node, instance_id: instanceId, item }) => {
        resumedCalls.push(instanceId);
        return { payload: { status: "passed", item, node: node.id } };
      },
    });
    expect(resumed.status).toBe("completed");
    expect(resumedCalls).not.toContain(identities[0]);
    expect(resumedCalls).toContain(identities[1]);
  });

  test("starts an any successor before the losing branch settles and keeps its evidence", async () => {
    const workflow = workflow21({
      nodes: [
        { id: "entry", kind: "agent", access: "read", guidance: "entry" },
        { id: "fast", kind: "agent", access: "read", guidance: "fast" },
        { id: "slow", kind: "agent", access: "read", guidance: "slow" },
        { id: "pick", kind: "join", access: "control", guidance: "pick", join: "any" },
        { id: "verify", kind: "gate", access: "control", guidance: "verify", verification: true },
        { id: "complete", kind: "terminal", access: "control", guidance: "complete" },
      ],
      edges: [
        { from: "entry", to: "fast", type: "sequence" },
        { from: "entry", to: "slow", type: "sequence" },
        { from: "fast", to: "pick", type: "artifact" },
        { from: "slow", to: "pick", type: "artifact" },
        { from: "pick", to: "verify", type: "sequence" },
        { from: "verify", to: "complete", type: "condition", condition: "success" },
      ],
    });
    const order = [];
    const result = await scheduleWorkflow({
      workflow,
      runId: "any-test",
      onEvent: ({ event, node_id: nodeId }) => {
        if (event === "node_instance_completed") order.push(nodeId);
      },
      execute: async ({ node }) => {
        if (node.id === "slow") await new Promise((accept) => setTimeout(accept, 25));
        return { payload: { status: "passed" } };
      },
    });
    expect(order.indexOf("pick")).toBeLessThan(order.indexOf("slow"));
    expect(result.completed.has("slow")).toBe(true);
  });

  test("streams matching map instances before the upstream stage barrier closes", async () => {
    const workflow = workflow21({
      nodes: [
        { id: "source", kind: "agent", access: "read", guidance: "source" },
        {
          id: "first",
          kind: "map",
          access: "read",
          guidance: "first",
          map: { source_pointer: "/items", stable_key_pointer: "/id" },
        },
        {
          id: "second",
          kind: "map",
          access: "read",
          guidance: "second",
          map: { source_pointer: "", stable_key_pointer: "/id" },
        },
        { id: "verify", kind: "gate", access: "control", guidance: "verify", verification: true },
        { id: "complete", kind: "terminal", access: "control", guidance: "complete" },
      ],
      edges: [
        { from: "source", to: "first", type: "artifact" },
        { from: "first", to: "second", type: "stream" },
        { from: "second", to: "verify", type: "artifact" },
        { from: "verify", to: "complete", type: "condition", condition: "success" },
      ],
    });
    const order = [];
    await scheduleWorkflow({
      workflow,
      runId: "stream-test",
      onEvent: (event) =>
        order.push(`${event.event}:${event.node_id ?? ""}:${event.item_key ?? ""}`),
      execute: async ({ node, item, item_key: itemKey }) => {
        if (node.id === "source") return { payload: { items: [{ id: "a" }, { id: "b" }] } };
        if (node.id === "first")
          await new Promise((accept) => setTimeout(accept, itemKey === "a" ? 2 : 25));
        return { payload: item ?? { status: "passed" } };
      },
    });
    const secondA = order.findIndex((entry) => entry.startsWith("node_instance_started:second:a"));
    const firstB = order.findIndex((entry) => entry.startsWith("node_instance_completed:first:b"));
    expect(secondA).toBeGreaterThan(-1);
    expect(secondA).toBeLessThan(firstB);
  });

  test("satisfies a quorum with one tolerated failure and fails when it becomes impossible", async () => {
    const nodes = [
      { id: "entry", kind: "agent", access: "read", guidance: "entry" },
      { id: "one", kind: "agent", access: "read", guidance: "one" },
      { id: "two", kind: "agent", access: "read", guidance: "two" },
      { id: "three", kind: "agent", access: "read", guidance: "three" },
      {
        id: "vote",
        kind: "join",
        access: "control",
        guidance: "vote",
        join: "quorum",
        quorum: { threshold: 2 },
      },
      { id: "verify", kind: "gate", access: "control", guidance: "verify", verification: true },
      { id: "complete", kind: "terminal", access: "control", guidance: "complete" },
    ];
    const edges = [
      ...["one", "two", "three"].map((to) => ({ from: "entry", to, type: "sequence" })),
      ...["one", "two", "three"].map((from) => ({ from, to: "vote", type: "artifact" })),
      { from: "vote", to: "verify", type: "sequence" },
      { from: "verify", to: "complete", type: "condition", condition: "success" },
    ];
    const workflow = workflow21({ nodes, edges });
    const success = await scheduleWorkflow({
      workflow,
      runId: "quorum-success",
      execute: async ({ node }) => {
        if (node.id === "three") throw new Error("fixture dissent");
        return { payload: { status: "passed" } };
      },
    });
    expect(success.status).toBe("completed");
    const impossible = structuredClone(workflow);
    impossible.nodes.find(({ id }) => id === "vote").quorum.threshold = 3;
    await expect(
      scheduleWorkflow({
        workflow: impossible,
        runId: "quorum-impossible",
        execute: async ({ node }) => {
          if (["two", "three"].includes(node.id)) throw new Error("fixture dissent");
          return { payload: { status: "passed" } };
        },
      }),
    ).rejects.toThrow(/quorum vote became impossible/);
  });

  test("converges an until-dry loop against keys seen in every prior round", async () => {
    const workflow = workflow21({
      nodes: [
        {
          id: "cycle",
          kind: "loop",
          access: "control",
          guidance: "bounded discovery",
          loop: {
            mode: "until-dry",
            max_iterations: 5,
            members: ["discover", "verify"],
            source_pointer: "/items",
            stable_key_pointer: "/id",
          },
        },
        { id: "discover", kind: "agent", access: "read", guidance: "discover" },
        { id: "verify", kind: "agent", access: "read", guidance: "verify", verification: true },
        { id: "complete", kind: "terminal", access: "control", guidance: "complete" },
      ],
      edges: [
        { from: "cycle", to: "discover", type: "sequence" },
        { from: "discover", to: "verify", type: "artifact" },
        { from: "verify", to: "discover", type: "loop-back" },
        { from: "verify", to: "complete", type: "condition", condition: "success" },
      ],
      entry: "cycle",
    });
    let discoveries = 0;
    let verificationRound = 0;
    const convergence = [];
    const result = await scheduleWorkflow({
      workflow,
      runId: "until-dry-test",
      onEvent: (event) => {
        if (event.event === "loop_convergence") convergence.push(event);
      },
      execute: async ({ node }) => {
        if (node.id === "discover") discoveries++;
        if (node.id === "verify") {
          verificationRound++;
          return { payload: { status: "passed", items: [{ id: "same" }] } };
        }
        return { payload: { status: "passed" } };
      },
    });
    expect(result.status).toBe("completed");
    expect(discoveries).toBe(2);
    expect(verificationRound).toBe(2);
    expect(convergence.map(({ dry }) => dry)).toEqual([false, true]);
  });
});
