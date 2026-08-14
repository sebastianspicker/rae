#!/usr/bin/env node
/** Purpose: control-plane migration, diagnostics, and experimental HTTP serving CLI. */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.mjs";
import { createAuthenticator } from "../src/auth.mjs";
import { createArtifactService } from "../src/artifacts.mjs";
import { createPlatformServer } from "../src/http.mjs";
import { createLogger, Metrics } from "../src/observability.mjs";
import { PostgresStore } from "../src/store.mjs";

const command = process.argv[2];
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliLogger = createLogger({ service: "rae-platform" });
async function main() {
  if (!new Set(["migrate", "doctor", "serve"]).has(command))
    throw new Error("usage: rae-platform <migrate|doctor|serve>");
  const config = await loadConfig();
  const store = PostgresStore.connect(config.database.url);
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
    await store.close();
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
    await store.close();
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
    metrics.leaseExpiries += expired;
  });
  const server = createPlatformServer({
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
  server.listen(config.server.port, config.server.host, () =>
    cliLogger("info", "experimental platform listening", {
      host: config.server.host,
      port: config.server.port,
    }),
  );
  const shutdown = () =>
    server.close(async () => {
      await stopReconciler();
      await store.close();
    });
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}
main().catch((error) => {
  cliLogger("error", "platform command failed", { error: error.message });
  process.exitCode = 1;
});
