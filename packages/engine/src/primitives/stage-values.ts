/** Normalizes stage configuration values used by deterministic artifact builders. */

export function toNumber(value: unknown, fallback: number): number {
  if (value === undefined || value === "" || value === null) return fallback;
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

export function coalesce<T>(...values: Array<T | null | undefined>): T | undefined {
  for (const value of values) {
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

export function mergeStageProfile<T extends Record<string, unknown>>(
  base: T | null | undefined,
  next: Partial<T> | null | undefined,
): T {
  return {
    ...(base || {}),
    ...(next || {}),
  } as T;
}
