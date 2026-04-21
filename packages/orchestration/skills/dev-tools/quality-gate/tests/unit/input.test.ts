import { describe, it, expect } from "vitest";
import type { Input } from "../../src/types.js";
import { validateInput } from "../../src/lib/input.js";

function makeInput(overrides: Partial<Input> = {}): Input {
  return {
    artifact: { summary: "ok" },
    schema_ref: "contracts/artifacts/brief.schema.json",
    phase: "arm",
    criteria: [{ name: "has-summary", type: "field-exists", path: "summary" }],
    ...overrides,
  };
}

describe("validateInput", () => {
  it("accepts valid pipeline phase values", () => {
    expect(() => validateInput(makeInput({ phase: "security-review" }))).not.toThrow();
    expect(() => validateInput(makeInput({ phase: "quality-static" }))).not.toThrow();
    expect(() => validateInput(makeInput({ phase: "quality-tests" }))).not.toThrow();
    expect(() => validateInput(makeInput({ phase: "release-readiness" }))).not.toThrow();
  });

  it("rejects unknown phases", () => {
    const input = makeInput({ phase: "quality-gate" as Input["phase"] });
    expect(() => validateInput(input)).toThrow("phase must be a valid pipeline phase");
  });

  it("rejects missing criteria", () => {
    const input = makeInput({ criteria: undefined as unknown as Input["criteria"] });
    expect(() => validateInput(input)).toThrow("criteria must be an array");
  });

  it("rejects non-string artifact_ref values", () => {
    const input = makeInput({ artifact_ref: 123 as unknown as Input["artifact_ref"] });
    expect(() => validateInput(input)).toThrow("artifact_ref must be a string when provided");
  });

  it("rejects unknown criterion types", () => {
    const input = makeInput({
      criteria: [{ name: "bad", type: "unknown" as Input["criteria"][number]["type"], path: "x" }],
    });
    expect(() => validateInput(input)).toThrow("Each criterion type must be one of");
  });

  it("requires numeric count-min values", () => {
    const input = makeInput({
      criteria: [
        {
          name: "min-items",
          type: "count-min",
          path: "items",
          value: "2" as unknown as number,
        },
      ],
    });
    expect(() => validateInput(input)).toThrow(
      "count-min criterion requires a non-negative integer value",
    );
  });

  it("requires non-negative integer count-min values", () => {
    const input = makeInput({
      criteria: [
        {
          name: "min-items",
          type: "count-min",
          path: "items",
          value: -1,
        },
      ],
    });
    expect(() => validateInput(input)).toThrow(
      "count-min criterion requires a non-negative integer value",
    );
  });

  it("requires non-empty string regex-match values", () => {
    const input = makeInput({
      criteria: [
        {
          name: "semver",
          type: "regex-match",
          path: "version",
          value: "",
        },
      ],
    });
    expect(() => validateInput(input)).toThrow(
      "regex-match criterion requires non-empty string value",
    );
  });

  it("requires numeric count-max values", () => {
    const input = makeInput({
      criteria: [
        {
          name: "max-items",
          type: "count-max",
          path: "items",
          value: "2" as unknown as number,
        },
      ],
    });
    expect(() => validateInput(input)).toThrow(
      "count-max criterion requires a non-negative integer value",
    );
  });

  it("requires non-negative number number-max values", () => {
    const input = makeInput({
      criteria: [
        {
          name: "budget",
          type: "number-max",
          path: "token_estimate",
          value: -1,
        },
      ],
    });
    expect(() => validateInput(input)).toThrow(
      "number-max criterion requires a non-negative number value",
    );
  });

  it("requires valid coverage-min shape", () => {
    const input = makeInput({
      criteria: [
        {
          name: "coverage",
          type: "coverage-min",
          path: "requirements",
          value: 1,
          source_path: "requirements",
          target_paths: [],
        },
      ],
    });
    expect(() => validateInput(input)).toThrow(
      "coverage-min criterion requires non-empty target_paths",
    );
  });
});
