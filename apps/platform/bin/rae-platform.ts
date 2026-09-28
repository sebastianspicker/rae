#!/usr/bin/env node
/** Purpose: control-plane migration, diagnostics, and experimental HTTP serving CLI. */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.js";
import { createAuthenticator } from "../src/auth.js";
import { createArtifactService } from "../src/artifacts.js";
import { createPlatformServer } from "../src/http.js";
import { createLogger, Metrics } from "../src/observability.js";
import { PostgresStore } from "../src/store.js";

const command = process.argv[2] ?? "";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const cliLogger = createLogger({ service: "rae-platform" });
async function main() {
  if (!new Set(["migrate", "doctor", "serve"]).has(command))
    throw new Error("usage: rae-platform <migrate|doctor|serve>");
  const config = await loadConfig();
  const store = PostgresStore.connect(config.database.url);
  const cleanup: (() => Promise<unknown>)[] = [() => store.close()];
  const stop = async () => {
    for (const action of cleanup.splice(0).reverse()) {
      try {
        await action();
      } catch (error) {
        cliLogger("error", "platform cleanup failed", {
          error: error instanceof Error ? error.message : "Unknown cleanup failure",
        });
        process.exitCode = 1;
      }
    }
  };
  let serving = false;
  try {
    if (command === "migrate") {
      const migrations = (await fs.readdir(path.join(root, "migrations")))
        .filter((name) => name.endsWith(".sql"))
        .sort();
      for (const version of migrations)
        await store.migrate(
          version,
          await fs.readFile(path.join(root, "migrations", version), "utf8"),
        );
      console.log(`experimental platform migrations applied: ${migrations.length}`);
      return;
    }
    if (command === "doctor") {
      if (!(await store.isReady()))
        throw new Error("database schema is stale; run explicit migrate first");
      console.log(
        JSON.stringify({
          experimental: true,
          database: "ready",
          oidc: Boolean(config.oidc),
          storage: Boolean(config.storage),
        }),
      );
      return;
    }
    if (!(await store.isReady()))
      throw new Error("database schema is stale; serve never applies migrations automatically");
    const publicBaseUrl =
      config.server.publicBaseUrl || `http://${config.server.host}:${config.server.port}`;
    const allowedHosts = [config.server.host];
    try {
      allowedHosts.push(new URL(publicBaseUrl).hostname);
    } catch {
      /* config validation rejects malformed URLs */
    }
    const metrics = new Metrics();
    const stopReconciler = await store.startReconciler(({ expired }) => {
      metrics.reconciliations += 1;
      metrics.leaseExpiries += expired ?? 0;
    });
    cleanup.push(stopReconciler);
    const management = createManagementServer({
      source: {
        isReady: (signal) => store.isReady(signal),
        lifecycleSnapshot: (signal) => store.metricsSnapshot(signal),
      },
      metrics,
      ...config.management,
    });
    cleanup.push(() => management.close());
    const server = createPlatformServer({
      ready: management.ready,
      store,
      authenticate: createAuthenticator(config),
      artifactService: config.storage
        ? createArtifactService({ store, storage: config.storage })
        : null,
      logger: createLogger({ service: "rae-platform" }),
      metrics,
      oidc: config.oidc,
      resourceBaseUrl: publicBaseUrl,
      allowedHosts,
    });
    cleanup.push(() => server.closeGracefully({ graceMs: 5000 }));
    await listen(management.server, config.management.port, management.host);
    await listen(server, config.server.port, config.server.host);
    cliLogger("info", "experimental platform listening", {
      host: config.server.host,
      port: config.server.port,
      managementHost: management.host,
      managementPort: config.management.port,
    });
    let shuttingDown = false;
    const shutdown = async () => {
      if (shuttingDown) return;
      shuttingDown = true;
      await stop();
    };
    process.once("SIGTERM", shutdown);
    process.once("SIGINT", shutdown);
    serving = true;
  } finally {
    if (!serving) await stop();
  }
}
main().catch((error) => {
  cliLogger("error", "platform command failed", { error: error.message });
  process.exitCode = 1;
});

import { createManagementServer } from "../src/management.js";

import type { Server } from "node:http";
async function listen(server: Server, port: number, host: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
}
