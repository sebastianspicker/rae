import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Runner tests share the repository-level .pipeline state contract.
    fileParallelism: false,
  },
});
