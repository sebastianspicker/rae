import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const packageRoot = resolve(import.meta.dirname, "../../..");

describe("eval script path safety", () => {
  it("rejects symlinked .pipeline before drift benchmark writes temp artifacts", () => {
    const root = mkdtempSync(join(tmpdir(), "rae-eval-root-"));
    const outside = mkdtempSync(join(tmpdir(), "rae-eval-outside-"));
    try {
      mkdirSync(join(root, "docs/eval/drift_goldset/cases"), { recursive: true });
      writeFileSync(
        join(root, "docs/eval/drift_goldset/cases/case.json"),
        `${JSON.stringify({
          id: "case",
          source: "source",
          target: "target",
          expected: [],
        })}\n`,
        "utf8",
      );
      symlinkSync(outside, join(root, ".pipeline"), "dir");

      const result = spawnSync(
        process.execPath,
        ["scripts/eval/drift-benchmark.mjs", "--root", root],
        {
          cwd: packageRoot,
          encoding: "utf8",
        },
      );

      expect(result.status).not.toBe(0);
      expect(`${result.stderr}\n${result.stdout}`).toContain("path escapes repository root");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
