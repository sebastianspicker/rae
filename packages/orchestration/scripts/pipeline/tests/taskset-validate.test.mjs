import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { validateTasksetSchema } from "../../eval/lib/taskset-validate.mjs";

const tempRoots = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function makeSchemaRoot() {
  const root = mkdtempSync(join(tmpdir(), "taskset-static-ajv-"));
  tempRoots.push(root);
  mkdirSync(join(root, "contracts"), { recursive: true });
  writeFileSync(
    join(root, "contracts/eval-taskset.schema.json"),
    JSON.stringify({
      type: "object",
      required: ["taskset_id", "owner"],
      properties: { taskset_id: { type: "string" }, owner: { type: "string" } },
    }),
  );
  return root;
}

describe("taskset validation dependency boundary", () => {
  it("does not load an Ajv package planted beneath the caller-provided root", () => {
    const root = makeSchemaRoot();
    const planted = join(root, "node_modules/ajv");
    mkdirSync(planted, { recursive: true });
    writeFileSync(
      join(planted, "package.json"),
      JSON.stringify({ name: "ajv", type: "module", exports: "./index.js" }),
    );
    writeFileSync(join(planted, "index.js"), 'throw new Error("planted Ajv executed");\n');

    expect(() =>
      validateTasksetSchema({
        root,
        tasksetPath: "taskset.json",
        taskset: { taskset_id: "safe", owner: "test" },
      }),
    ).not.toThrow();
  });

  it("retains deterministic schema rejection", () => {
    const root = makeSchemaRoot();
    expect(() => validateTasksetSchema({ root, tasksetPath: "taskset.json", taskset: {} })).toThrow(
      "Taskset schema validation failed",
    );
  });

  it("reports every independent schema violation", () => {
    const root = makeSchemaRoot();
    expect(() =>
      validateTasksetSchema({
        root,
        tasksetPath: "taskset.json",
        taskset: { taskset_id: 1, owner: 2 },
      }),
    ).toThrow(/\/owner[\s\S]*\/taskset_id|\/taskset_id[\s\S]*\/owner/);
  });
});
