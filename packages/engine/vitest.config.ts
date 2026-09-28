/**
 * Configures the compact pipeline boundary tests.
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "src/tests/legacy/argv-security.test.js",
      "src/tests/legacy/agent-provider-event-log-security.test.js",
      "src/tests/legacy/operator-cli.test.js",
    ],
    fileParallelism: false,
  },
});
