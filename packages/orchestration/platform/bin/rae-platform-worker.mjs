#!/usr/bin/env node
/** Purpose: experimental worker diagnostics and polling CLI. */
import { runWorker } from "../src/worker.mjs";
import { createLocalClaimExecutor, doctorLocalClaimExecutor } from "../src/local-executor.mjs";

const command = process.argv[2];
if (command === "doctor") {
  const missing = [
    "RAE_PLATFORM_URL",
    "RAE_PLATFORM_TOKEN",
    "RAE_WORKER_ID",
    "RAE_REPOSITORY_DIGEST",
    "RAE_WORKTREE_DIGEST",
    "RAE_PROJECT_MAP_FILE",
  ].filter((name) => !process.env[name]);
  console.log(
    JSON.stringify({
      experimental: true,
      status: missing.length ? "blocked" : "ready",
      missing,
      surfaces: missing.length
        ? []
        : doctorLocalClaimExecutor({ projectMapFile: process.env.RAE_PROJECT_MAP_FILE }),
    }),
  );
  process.exitCode = missing.length ? 1 : 0;
} else if (command === "run") {
  const baseUrl = process.env.RAE_PLATFORM_URL;
  const token = process.env.RAE_PLATFORM_TOKEN;
  if (
    !baseUrl ||
    !token ||
    !process.env.RAE_WORKER_ID ||
    !process.env.RAE_REPOSITORY_DIGEST ||
    !process.env.RAE_WORKTREE_DIGEST ||
    !process.env.RAE_PROJECT_MAP_FILE
  )
    throw new Error(
      "platform URL, token, stable worker ID, project map, repository digest, and worktree digest are required",
    );
  const workerId = process.env.RAE_WORKER_ID;
  await runWorker({
    baseUrl,
    token,
    workerId,
    repositoryDigest: process.env.RAE_REPOSITORY_DIGEST,
    worktreeDigest: process.env.RAE_WORKTREE_DIGEST,
    allowInsecureDevelopment: process.env.RAE_PLATFORM_ALLOW_INSECURE_DEVELOPMENT === "true",
    execute: createLocalClaimExecutor({ projectMapFile: process.env.RAE_PROJECT_MAP_FILE }),
  });
} else {
  throw new Error("usage: rae-platform-worker <doctor|run>");
}
