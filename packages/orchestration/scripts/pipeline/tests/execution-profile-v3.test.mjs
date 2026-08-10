/** Verifies provider-neutral execution profile v3 validation and route resolution. */
import { describe, expect, test } from "vitest";
import {
  assertExecutionProfileCoverage,
  executionProfileDigest,
  executionProfileExecutors,
  resolveExecutionTier,
  resolveWorkflowRoutes,
  validateExecutionProfile,
} from "../lib/execution-profile.mjs";

const profile = {
  schema_version: "3.0.0",
  profile_id: "mixed-local",
  routes: {
    cheap: { executor: "opencode", model: "opencode/small" },
    normal: { executor: "codex", model: "gpt-5.6-terra", reasoning_effort: "medium" },
    judge: { executor: "opencode", model: "openrouter/example", variant: "high" },
  },
  tiers: { economy: "cheap", standard: "normal", judgment: "judge" },
  node_routes: { inspect: "judge" },
};

const workflow = {
  nodes: [
    { id: "inspect", kind: "agent", tier: "economy" },
    { id: "apply", kind: "agent", tier: "standard" },
    { id: "gate", kind: "gate" },
  ],
};

describe("execution profile v3", () => {
  test("resolves tier and per-node routes without executable or credential fields", () => {
    const validated = validateExecutionProfile(profile);
    expect(resolveExecutionTier(validated, "economy", "inspect")).toEqual({
      tier: "economy",
      route_id: "judge",
      executor: "opencode",
      model: "openrouter/example",
      variant: "high",
    });
    expect(resolveWorkflowRoutes(validated, workflow).map((route) => route.route_id)).toEqual([
      "judge",
      "normal",
    ]);
    expect(executionProfileExecutors(validated)).toEqual(["codex", "opencode"]);
    expect(executionProfileDigest(validated)).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(validated)).not.toMatch(/credential|command|executable|https?:/i);
  });

  test("rejects undefined route references and unrelated node overrides", () => {
    expect(() =>
      validateExecutionProfile({ ...profile, tiers: { ...profile.tiers, economy: "missing" } }),
    ).toThrow(/undefined route missing/);
    expect(() =>
      assertExecutionProfileCoverage(
        validateExecutionProfile({ ...profile, node_routes: { absent: "cheap" } }),
        workflow,
      ),
    ).toThrow(/outside the workflow: absent/);
  });

  test("rejects commands, paths, credentials, tools, and remote references by schema", () => {
    for (const [field, value] of [
      ["command", ["opencode"]],
      ["executable", "/usr/bin/opencode"],
      ["credentials", { token: "secret" }],
      ["tools", ["bash"]],
      ["url", "https://example.invalid"],
    ]) {
      const unsafe = structuredClone(profile);
      unsafe.routes.cheap[field] = value;
      expect(() => validateExecutionProfile(unsafe)).toThrow(/invalid execution profile/);
    }
  });
});
