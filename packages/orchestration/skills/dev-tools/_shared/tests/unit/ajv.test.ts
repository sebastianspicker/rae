import { describe, it, expect } from "vitest";
import { getAjv, getAddFormats, createAjvInstance } from "../../src/ajv.js";

describe("getAjv", () => {
  it("returns a constructor", async () => {
    const Ajv = await getAjv();
    expect(typeof Ajv).toBe("function");
  });

  it("returns the same reference on subsequent calls", async () => {
    const a = await getAjv();
    const b = await getAjv();
    expect(a).toBe(b);
  });
});

describe("getAddFormats", () => {
  it("returns a function", async () => {
    const fn = await getAddFormats();
    expect(typeof fn).toBe("function");
  });
});

describe("createAjvInstance", () => {
  it("returns an AJV instance that can compile schemas", async () => {
    const ajv = await createAjvInstance();
    const validate = ajv.compile({
      type: "object",
      required: ["name"],
      properties: { name: { type: "string" } },
    });
    expect(validate({ name: "test" })).toBe(true);
    expect(validate({})).toBe(false);
  });

  it("supports date-time format validation by default", async () => {
    const ajv = await createAjvInstance();
    const validate = ajv.compile({
      type: "object",
      properties: { ts: { type: "string", format: "date-time" } },
    });
    expect(validate({ ts: "2025-01-01T00:00:00Z" })).toBe(true);
    expect(validate({ ts: "not-a-date" })).toBe(false);
  });

  it("supports uri format validation by default", async () => {
    const ajv = await createAjvInstance();
    const validate = ajv.compile({
      type: "object",
      properties: { url: { type: "string", format: "uri" } },
    });
    expect(validate({ url: "https://example.com" })).toBe(true);
    expect(validate({ url: "not a uri" })).toBe(false);
  });

  it("collects all errors", async () => {
    const ajv = await createAjvInstance();
    const validate = ajv.compile({
      type: "object",
      required: ["a", "b"],
      properties: { a: { type: "string" }, b: { type: "number" } },
    });
    validate({});
    expect(validate.errors).toBeDefined();
    expect(validate.errors?.length).toBeGreaterThanOrEqual(2);
  });
});
