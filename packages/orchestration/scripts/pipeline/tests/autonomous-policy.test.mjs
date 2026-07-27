/** Verifies the experimental policy seam cannot expand autonomous runtime authority. */
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadAutonomousPolicy,
  policyDigest,
  validateAutonomousPolicy,
} from "../../lib/autonomous-policy.mjs";

const roots = [];
const packageRoot = resolve(import.meta.dirname, "../../..");
const require = createRequire(import.meta.url);

function policySchemaValidator() {
  const ajvPath = require.resolve("ajv/dist/2020", {
    paths: [resolve(packageRoot, "skills/dev-tools/multi-model-review")],
  });
  const Ajv2020 = require(ajvPath).default;
  const schema = JSON.parse(
    readFileSync(resolve(packageRoot, "contracts/autonomous-policy.schema.json"), "utf8"),
  );
  return new Ajv2020({ allErrors: true, strict: false }).compile(schema);
}

afterEach(() => {
  roots.splice(0).forEach((root) => {
    rmSync(root, { recursive: true, force: true });
  });
});

describe("autonomous policy", () => {
  it("loads the default policy with a stable digest", () => {
    const first = loadAutonomousPolicy();
    const reordered = Object.fromEntries(Object.entries(first.policy).reverse());
    expect(first.policy.policy_id).toBe("default");
    expect(policyDigest(reordered)).toBe(first.digest);
  });

  it("rejects fields that could expand the mutable trust boundary", () => {
    const candidate = structuredClone(loadAutonomousPolicy().policy);
    candidate.model = "untrusted-model";
    expect(() => validateAutonomousPolicy(candidate)).toThrow("must contain exactly");
  });

  it("rejects removal of safety-critical predecessor artifacts", () => {
    const candidate = structuredClone(loadAutonomousPolicy().policy);
    candidate.phase_inputs.build = ["brief.json"];
    expect(() => validateAutonomousPolicy(candidate)).toThrow("omits required references");
  });

  it("keeps the published schema aligned with phase-specific runtime input rules", () => {
    const validateSchema = policySchemaValidator();
    const optionalInputsRemoved = structuredClone(loadAutonomousPolicy().policy);
    optionalInputsRemoved.phase_inputs.build = ["plan.json", "drift-reports/pmatch.json"];
    expect(() => validateAutonomousPolicy(optionalInputsRemoved)).not.toThrow();
    expect(validateSchema(optionalInputsRemoved)).toBe(true);

    const requiredInputRemoved = structuredClone(optionalInputsRemoved);
    requiredInputRemoved.phase_inputs.build = ["drift-reports/pmatch.json"];
    expect(() => validateAutonomousPolicy(requiredInputRemoved)).toThrow(
      "omits required references",
    );
    expect(validateSchema(requiredInputRemoved)).toBe(false);

    const crossPhaseInput = structuredClone(optionalInputsRemoved);
    crossPhaseInput.phase_inputs.build.push("quality-reports/tests.json");
    expect(() => validateAutonomousPolicy(crossPhaseInput)).toThrow("invalid references");
    expect(validateSchema(crossPhaseInput)).toBe(false);
  });

  it("refuses protected credential-like policy paths without reading them", () => {
    const root = mkdtempSync(join(tmpdir(), "rae-policy-"));
    roots.push(root);
    const path = join(root, ".env");
    writeFileSync(path, "not-json", "utf8");
    expect(() => loadAutonomousPolicy(path)).toThrow("protected credential or key path");
  });

  it("refuses a safe-looking symlink whose canonical target is credential-like", () => {
    const root = mkdtempSync(join(tmpdir(), "rae-policy-link-"));
    roots.push(root);
    const target = join(root, "auth.json");
    const link = join(root, "candidate.json");
    writeFileSync(target, JSON.stringify(loadAutonomousPolicy().policy), "utf8");
    symlinkSync(target, link);
    expect(() => loadAutonomousPolicy(link)).toThrow("protected credential or key path");
  });
});
