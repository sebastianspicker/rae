/**
 * Configures the compact pipeline boundary tests.
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "src/tests/legacy/argv-security.test.mjs",
      "src/tests/legacy/agent-provider-event-log-security.test.mjs",
      "src/tests/legacy/operator-cli.test.mjs",
    ],
    fileParallelism: false,
  },
});
