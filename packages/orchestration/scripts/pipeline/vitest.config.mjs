/**
 * Configures the compact pipeline boundary tests.
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "tests/argv-security.test.mjs",
      "tests/agent-provider-event-log-security.test.mjs",
      "tests/operator-cli.test.mjs",
    ],
    fileParallelism: false,
  },
});
