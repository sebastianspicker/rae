import { describe, it, expect } from "vitest";
import { toNumber, coalesce, mergeStageProfile } from "../lib/utils.mjs";

describe("toNumber", () => {
  it("converts numeric strings", () => {
    expect(toNumber("42", 0)).toBe(42);
    expect(toNumber("3.14", 0)).toBeCloseTo(3.14);
  });

  it("returns fallback for non-numeric strings", () => {
    expect(toNumber("abc", 99)).toBe(99);
  });

  it("returns fallback for empty string", () => {
    expect(toNumber("", 99)).toBe(99);
  });

  it("returns fallback for NaN and Infinity", () => {
    expect(toNumber(NaN, 5)).toBe(5);
    expect(toNumber(Infinity, 5)).toBe(5);
    expect(toNumber(-Infinity, 5)).toBe(5);
  });

  it("passes through finite numbers", () => {
    expect(toNumber(7, 0)).toBe(7);
    expect(toNumber(0, 99)).toBe(0);
    expect(toNumber(-1, 99)).toBe(-1);
  });

  it("returns fallback for null", () => {
    expect(toNumber(null, 10)).toBe(10);
  });

  it("returns fallback for undefined", () => {
    expect(toNumber(undefined, 10)).toBe(10);
  });
});

describe("coalesce", () => {
  it("returns first non-null/undefined value", () => {
    expect(coalesce(null, undefined, 42)).toBe(42);
    expect(coalesce(0, 1)).toBe(0);
    expect(coalesce("", "fallback")).toBe("");
    expect(coalesce(false, true)).toBe(false);
  });

  it("returns undefined when all values are null/undefined", () => {
    expect(coalesce(null, undefined)).toBeUndefined();
    expect(coalesce()).toBeUndefined();
  });
});

describe("mergeStageProfile", () => {
  it("merges two objects", () => {
    const result = mergeStageProfile({ a: 1 }, { b: 2 });
    expect(result).toEqual({ a: 1, b: 2 });
  });

  it("next overrides base", () => {
    const result = mergeStageProfile({ a: 1 }, { a: 2 });
    expect(result).toEqual({ a: 2 });
  });

  it("handles null/undefined inputs", () => {
    expect(mergeStageProfile(null, { b: 2 })).toEqual({ b: 2 });
    expect(mergeStageProfile({ a: 1 }, null)).toEqual({ a: 1 });
    expect(mergeStageProfile(null, null)).toEqual({});
  });
});
