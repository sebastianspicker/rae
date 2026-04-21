import { describe, it, expect } from "vitest";
import { badInput } from "../../src/errors.js";

describe("badInput", () => {
  it("returns an Error with E_BAD_INPUT code", () => {
    const err = badInput("something went wrong") as Error & { code: string };
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe("something went wrong");
    expect(err.code).toBe("E_BAD_INPUT");
  });

  it("includes a stack trace", () => {
    const err = badInput("test");
    expect(err.stack).toBeDefined();
  });
});
