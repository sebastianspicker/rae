/** Enforce the repository's Node-only runtime floor before command dispatch. */
export function assertNodeRuntime(version = process.versions.node): void {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-[A-Za-z0-9.-]+)?$/.exec(version);
  if (!match || !Number.isSafeInteger(Number(match[1])) || Number(match[1]) < 24)
    throw new Error(`RAE requires Node.js 24 or newer; found ${version}`);
}
