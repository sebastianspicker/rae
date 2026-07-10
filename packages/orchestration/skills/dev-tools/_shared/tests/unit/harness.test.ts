import { afterEach, describe, expect, it, vi } from "vitest";
import { runTool } from "../../src/harness.js";

const originalArgv = [...process.argv];

afterEach(() => {
  process.argv = [...originalArgv];
  vi.restoreAllMocks();
});

describe("runTool healthcheck", () => {
  it("returns a bounded health response without reading stdin or invoking the handler", async () => {
    process.argv = [process.execPath, "tool.js", "--healthcheck"];
    const writes: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });
    const handler = vi.fn();

    await runTool("1.2.3", handler);

    expect(handler).not.toHaveBeenCalled();
    expect(JSON.parse(writes.join(""))).toEqual({
      success: true,
      data: { status: "ok" },
      metadata: { tool_version: "1.2.3" },
      logs: [],
    });
  });
});
