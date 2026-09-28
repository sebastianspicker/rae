/** Runs compiled tool entrypoints and optional CI images using identical JSON protocol fixtures. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "../../..");
const brief = {
  requirements: [{ id: "req-1", description: "Preserve evidence", priority: "must" }],
  constraints: [],
  non_goals: [],
  style: { tone: "concise" },
  key_concepts: [],
  decisions: [],
  open_questions: [],
};
const cases = [
  {
    name: "quality-gate",
    input: {
      artifact: brief,
      schema_ref: "packages/contracts/v1/schemas/artifacts/brief.schema.json",
      phase: "arm",
      criteria: [],
    },
    check: (data) => assert.equal(data.status, "pass"),
  },
  {
    name: "trace-collector",
    input: {
      run_id: "run-fixture",
      events: [
        {
          run_id: "run-fixture",
          event: "agent_call",
          phase: "arm",
          ts: "2026-09-06T00:00:00Z",
          status: "pass",
        },
      ],
    },
    check: (data) => assert.equal(data.valid, true),
  },
  {
    name: "multi-model-review",
    input: {
      action: { type: "review" },
      document: { content: "Deterministic review fixture", type: "plan" },
      reviewer_findings: [
        {
          reviewer_id: "local",
          role: "reviewer",
          findings: [
            { id: "F-1", category: "docs", description: "Clarify fixture", severity: "low" },
          ],
        },
      ],
    },
    check: (data) => assert.ok(data),
  },
];

function invoke(name, input, args = []) {
  const imagePrefix = process.env.RAE_TOOL_IMAGE_PREFIX;
  const command = imagePrefix ? "docker" : process.execPath;
  const entry = resolve(root, `packages/dev-tools/${name}/dist/index.js`);
  const argv = imagePrefix
    ? ["run", "--rm", "-i", `${imagePrefix}${name}`, ...args]
    : [entry, ...args];
  const result = spawnSync(command, argv, {
    cwd: root,
    input,
    encoding: "utf8",
    timeout: 30_000,
    env: { ...process.env, WORKSPACE_ROOT: root, RAE_TOOL_ROOT: root },
  });
  assert.ifError(result.error);
  assert.equal(result.stderr, "");
  return { code: result.status, value: JSON.parse(result.stdout) };
}

for (const fixture of cases) {
  test(`${fixture.name}: health and valid/invalid executable protocol`, () => {
    const health = invoke(fixture.name, "", ["--healthcheck"]);
    assert.equal(health.code, 0);
    assert.equal(health.value.data.status, "ok");
    const valid = invoke(fixture.name, JSON.stringify(fixture.input));
    assert.equal(valid.code, 0, JSON.stringify(valid.value));
    assert.equal(valid.value.success, true);
    fixture.check(valid.value.data);
    for (const input of ["", "not-json", "{}", "[]"]) {
      const invalid = invoke(fixture.name, input);
      assert.equal(invalid.code, 1);
      assert.equal(invalid.value.success, false);
      assert.ok(invalid.value.error.message);
      assert.equal(invalid.value.error.details, undefined);
    }
  });
}

test("compiled runner exports resolve through package names", {
  skip: Boolean(process.env.RAE_TOOL_IMAGE_PREFIX),
}, () => {
  for (const name of ["quality-gate-skill/runner", "trace-collector-skill/runner"]) {
    const path = fileURLToPath(import.meta.resolve(name));
    assert.ok(path.endsWith("/dist/index.js"));
    const result = spawnSync(process.execPath, [path, "--healthcheck"], { encoding: "utf8" });
    assert.equal(result.status, 0);
    assert.equal(JSON.parse(result.stdout).success, true);
  }
});
