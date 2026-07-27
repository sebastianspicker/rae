/**
 * Configures serial pipeline integration tests because shared state fixtures cannot safely run concurrently.
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.mjs"],
    // Several CLI integration suites intentionally exercise the repository's
    // singleton .pipeline state. Running those files in parallel makes their
    // lock and state fixtures contend with each other.
    fileParallelism: false,
  },
});
