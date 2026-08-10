/** Keeps execution-profile files server-side and exposes a deliberately small public projection. */
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const executionProfilePath = resolve(
  import.meta.dirname,
  "../../scripts/pipeline/lib/execution-profile.mjs",
);

function unavailable(message) {
  throw Object.assign(new Error(message), { status: 503 });
}

function publicProfile({ profile }) {
  const routeRecords =
    profile.schema_version === "3.0.0"
      ? Object.entries(profile.routes).map(([id, route]) => ({ id, ...route }))
      : Object.entries(profile.tiers ?? {}).map(([id, route]) => ({
          id,
          executor: "codex",
          ...route,
        }));
  const models =
    profile.schema_version === "3.0.0"
      ? Object.fromEntries(
          Object.entries(profile.tiers).map(([tier, routeId]) => [
            tier,
            profile.routes[routeId].model,
          ]),
        )
      : Object.fromEntries(
          Object.entries(profile.tiers ?? {}).map(([tier, mapping]) => [tier, mapping.model]),
        );
  return Object.freeze({
    id: profile.profile_id,
    routes: routeRecords.sort((left, right) => left.id.localeCompare(right.id)),
    models,
    readiness: "loaded",
  });
}

/**
 * Loads each explicitly supplied profile once at server startup. Source paths,
 * environment names, capabilities, and profile contents never leave this map.
 */
export async function loadOperatorProfiles(paths = []) {
  if (!Array.isArray(paths)) throw new Error("execution profiles must be an array");
  if (paths.length > 16) throw new Error("at most 16 execution profiles may be loaded");
  if (paths.length === 0) return new OperatorProfiles();
  if (!existsSync(executionProfilePath)) unavailable("execution profile support is unavailable");
  const module = await import(pathToFileURL(executionProfilePath).href);
  if (typeof module.loadExecutionProfile !== "function") {
    unavailable("execution profile support is unavailable");
  }
  const loaded = paths.map((pathValue) => module.loadExecutionProfile(pathValue));
  return new OperatorProfiles(loaded);
}

export class OperatorProfiles {
  constructor(loaded = []) {
    this.records = new Map();
    for (const record of loaded) {
      const id = record?.profile?.profile_id;
      if (typeof id !== "string" || !id) throw new Error("invalid execution profile");
      if (this.records.has(id)) throw new Error(`duplicate execution profile id: ${id}`);
      this.records.set(id, Object.freeze(record));
    }
  }

  list() {
    return [...this.records.values()]
      .map(publicProfile)
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  resolve(id) {
    if (id === undefined || id === null || id === "") return null;
    if (typeof id !== "string" || !/^[a-z][a-z0-9-]{2,63}$/.test(id)) {
      throw Object.assign(new Error("invalid execution_profile_id"), { status: 400 });
    }
    const record = this.records.get(id);
    if (!record) throw Object.assign(new Error("unknown execution_profile_id"), { status: 400 });
    return record;
  }
}
