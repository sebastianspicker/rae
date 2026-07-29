/** Verifies shared development tools retain their sandbox boundaries. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const orchestrationRoot = resolve(import.meta.dirname, "../../../../..");
const sandboxDockerfiles = [
  "skills/dev-tools/multi-model-review/sandbox/Dockerfile",
  "skills/dev-tools/quality-gate/sandbox/Dockerfile",
  "skills/dev-tools/trace-collector/sandbox/Dockerfile",
];

describe("sandbox healthcheck contract", () => {
  for (const relativePath of sandboxDockerfiles) {
    it(`${relativePath} runs the shared healthcheck as the non-root user`, () => {
      const dockerfile = readFileSync(resolve(orchestrationRoot, relativePath), "utf8");
      const userIndex = dockerfile.indexOf("USER skill");
      const healthIndex = dockerfile.indexOf(
        'HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 CMD ["node", "dist/index.js", "--healthcheck"]',
      );

      expect(userIndex).toBeGreaterThanOrEqual(0);
      expect(healthIndex).toBeGreaterThan(userIndex);
      expect(dockerfile.slice(healthIndex)).not.toContain("USER root");
    });
  }
});
