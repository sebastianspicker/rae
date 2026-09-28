/** Keeps execution-profile files server-side and exposes a deliberately small public projection. */
import { loadExecutionProfile } from "@rae/engine";

interface ExecutionRoute {
  model: string;
  executor?: string;
}

interface ExecutionProfile {
  schema_version: string;
  profile_id: string;
  routes?: Record<string, ExecutionRoute>;
  tiers?: Record<string, string | ExecutionRoute>;
}

export interface LoadedExecutionProfile {
  readonly profile: ExecutionProfile;
  readonly digest: string;
  readonly source: string;
}

interface PublicExecutionProfile {
  readonly id: string;
  readonly routes: ReadonlyArray<ExecutionRoute & { id: string }>;
  readonly models: Readonly<Record<string, string>>;
  readonly readiness: "loaded";
}

function v3Routes(profile: ExecutionProfile): Record<string, ExecutionRoute> {
  return profile.routes ?? {};
}

function publicProfile({ profile }: LoadedExecutionProfile): PublicExecutionProfile {
  const routeRecords =
    profile.schema_version === "3.0.0"
      ? Object.entries(v3Routes(profile)).map(([id, route]) => ({ id, ...route }))
      : Object.entries(profile.tiers ?? {}).map(([id, route]) => ({
          id,
          executor: "codex",
          ...(typeof route === "string" ? { model: route } : route),
        }));
  const models =
    profile.schema_version === "3.0.0"
      ? Object.fromEntries(
          Object.entries(profile.tiers ?? {}).map(([tier, routeId]) => [
            tier,
            typeof routeId === "string" ? (v3Routes(profile)[routeId]?.model ?? "") : routeId.model,
          ]),
        )
      : Object.fromEntries(
          Object.entries(profile.tiers ?? {}).map(([tier, mapping]) => [
            tier,
            typeof mapping === "string" ? mapping : mapping.model,
          ]),
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
export async function loadOperatorProfiles(
  paths: readonly string[] = [],
): Promise<OperatorProfiles> {
  if (!Array.isArray(paths)) throw new Error("execution profiles must be an array");
  if (paths.length > 16) throw new Error("at most 16 execution profiles may be loaded");
  if (paths.length === 0) return new OperatorProfiles();
  const loaded = paths.map(
    (pathValue) => loadExecutionProfile(pathValue) as LoadedExecutionProfile,
  );
  return new OperatorProfiles(loaded);
}

export class OperatorProfiles {
  private readonly records: Map<string, LoadedExecutionProfile>;

  constructor(loaded: readonly LoadedExecutionProfile[] = []) {
    this.records = new Map<string, LoadedExecutionProfile>();
    for (const record of loaded) {
      const id = record?.profile?.profile_id;
      if (typeof id !== "string" || !id) throw new Error("invalid execution profile");
      if (this.records.has(id)) throw new Error(`duplicate execution profile id: ${id}`);
      this.records.set(id, Object.freeze(record));
    }
  }

  list(): PublicExecutionProfile[] {
    return [...this.records.values()]
      .map(publicProfile)
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  resolve(id: unknown): LoadedExecutionProfile | null {
    if (id === undefined || id === null || id === "") return null;
    if (typeof id !== "string" || !/^[a-z][a-z0-9-]{2,63}$/.test(id)) {
      throw Object.assign(new Error("invalid execution_profile_id"), { status: 400 });
    }
    const record = this.records.get(id);
    if (!record) throw Object.assign(new Error("unknown execution_profile_id"), { status: 400 });
    return record;
  }
}
