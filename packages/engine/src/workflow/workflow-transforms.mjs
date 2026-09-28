/** Executes the v2.1 data-only transform allowlist without evaluating workflow code. */
import { canonicalJson } from "./workflow-contract.mjs";

export function pointerValue(value, pointer = "") {
  if (pointer === "") return value;
  if (typeof pointer !== "string" || !pointer.startsWith("/"))
    throw new Error(`invalid RFC 6901 pointer: ${pointer}`);
  return pointer
    .slice(1)
    .split("/")
    .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"))
    .reduce((current, part) => current?.[part], value);
}

function arrayAt(value, pointer) {
  const selected = pointerValue(value, pointer ?? "");
  if (!Array.isArray(selected))
    throw new Error(`transform source ${pointer ?? ""} is not an array`);
  return selected;
}

function stableCompare(left, right) {
  return canonicalJson(left).localeCompare(canonicalJson(right));
}

function selectTransform(config, input) {
  return arrayAt(input, config.source_pointer).map((item) =>
    pointerValue(item, config.value_pointer ?? ""),
  );
}

function deduplicateTransform(config, input) {
  const seen = new Set();
  return arrayAt(input, config.source_pointer).filter((item) => {
    const key = canonicalJson(pointerValue(item, config.key_pointer ?? ""));
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function sortTransform(config, input) {
  return [...arrayAt(input, config.source_pointer)].sort((left, right) => {
    const result = stableCompare(
      pointerValue(left, config.key_pointer ?? ""),
      pointerValue(right, config.key_pointer ?? ""),
    );
    return config.descending ? -result : result;
  });
}

function groupTransform(config, input) {
  const groups = new Map();
  for (const item of arrayAt(input, config.source_pointer)) {
    const keyValue = pointerValue(item, config.key_pointer ?? "");
    const key = canonicalJson(keyValue);
    if (!groups.has(key)) groups.set(key, { key: keyValue, items: [] });
    groups.get(key).items.push(item);
  }
  return [...groups.values()].sort((left, right) => stableCompare(left.key, right.key));
}

function cartesianTransform(config, input) {
  let product = [[]];
  for (const values of config.pointers.map((pointer) => arrayAt(input, pointer))) {
    product = product.flatMap((prefix) => values.map((value) => [...prefix, value]));
    if (product.length > config.limit) throw new Error("Cartesian transform exceeds its bound");
  }
  return product.slice(0, config.limit);
}

export function applyWorkflowTransform(config, input) {
  switch (config.operation) {
    case "select":
      return selectTransform(config, input);
    case "flatten":
      return arrayAt(input, config.source_pointer).flat(1);
    case "deduplicate":
      return deduplicateTransform(config, input);
    case "sort":
      return sortTransform(config, input);
    case "limit":
      return arrayAt(input, config.source_pointer).slice(0, config.limit);
    case "group":
      return groupTransform(config, input);
    case "cartesian":
      return cartesianTransform(config, input);
    default:
      throw new Error(`unsupported workflow transform ${config.operation}`);
  }
}

/** Records every discovered key before filtering so rejected duplicates cannot reappear later. */
export function deduplicateDiscovery(items, stableKeyPointer, seenKeys = []) {
  if (!Array.isArray(items) || items.length > 32)
    throw new Error("until-dry discovery must contain at most 32 items per round");
  const seen = new Set(seenKeys);
  const fresh = [];
  const rejected = [];
  for (const item of items) {
    const value = pointerValue(item, stableKeyPointer);
    if (!["string", "number", "boolean"].includes(typeof value))
      throw new Error("until-dry stable key must be a scalar");
    const key = String(value);
    if (seen.has(key)) rejected.push(item);
    else fresh.push(item);
    seen.add(key);
  }
  return Object.freeze({ fresh, rejected, seen_keys: [...seen].sort(), dry: fresh.length === 0 });
}
