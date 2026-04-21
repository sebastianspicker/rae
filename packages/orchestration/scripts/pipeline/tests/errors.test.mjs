import { describe, it, expect } from "vitest";
import { badInput, badTrace } from "../lib/errors.mjs";

describe("badInput", () => {
  it("returns Error with E_BAD_INPUT code", () => {
    const err = badInput("test message");
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe("test message");
    expect(err.code).toBe("E_BAD_INPUT");
  });
});

describe("badTrace", () => {
  it("returns Error with E_BAD_TRACE code", () => {
    const err = badTrace("trace error");
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe("trace error");
    expect(err.code).toBe("E_BAD_TRACE");
  });
});
