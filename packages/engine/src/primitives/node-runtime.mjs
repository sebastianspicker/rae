/** Shared startup guard for package entrypoints that may bypass the umbrella CLI. */
export const NODE_RUNTIME_RANGE = ">=20.19.0 <21 || >=22.12.0 <23 || >=24.0.0";

export function nodeVersionSupported(version) {
  const match = String(version ?? "").match(/^v?(\d+)\.(\d+)\.(\d+)$/);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (major === 20) return minor >= 19;
  if (major === 22) return minor >= 12;
  return major >= 24;
}

export function assertSupportedNodeRuntime(version = process.versions.node) {
  if (!nodeVersionSupported(version)) {
    throw new Error(`unsupported Node.js ${version}; RAE requires ${NODE_RUNTIME_RANGE}`);
  }
}
