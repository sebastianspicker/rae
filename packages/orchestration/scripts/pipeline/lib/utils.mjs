/**
 * Shared tiny utility functions for pipeline scripts.
 */

export function toNumber(value, fallback) {
  if (value === undefined || value === "" || value === null) return fallback;
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

export function coalesce(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

export function mergeStageProfile(base, next) {
  return {
    ...(base || {}),
    ...(next || {}),
  };
}
