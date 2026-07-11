function badInput(message) {
  const err = new Error(message);
  err.code = "E_BAD_INPUT";
  return err;
}

const UNSAFE_KEYS = new Set(["__proto__", "prototype", "constructor", "toString"]);

function assertSafeKey(key, label) {
  if (UNSAFE_KEYS.has(key)) {
    throw badInput(`${label} is not allowed: ${key}`);
  }
}

function parseBoolean(raw, flagName) {
  if (typeof raw === "boolean") return raw;
  if (raw === "true" || raw === "1") return true;
  if (raw === "false" || raw === "0") return false;
  throw badInput(`Invalid boolean for --${flagName}: ${raw}`);
}

function readRawValue(type, hasInline, inlineValue, next, flagName) {
  if (hasInline) return { rawValue: inlineValue, consumesNext: false };
  if (type === "boolean") {
    return next && !next.startsWith("--")
      ? { rawValue: next, consumesNext: true }
      : { rawValue: true, consumesNext: false };
  }
  if (!next || next.startsWith("--")) throw badInput(`Missing value for --${flagName}`);
  return { rawValue: next, consumesNext: true };
}

function parseValue(type, rawValue, flagName) {
  if (type === "number") {
    const value = Number(rawValue);
    if (!Number.isFinite(value)) throw badInput(`Invalid number for --${flagName}: ${rawValue}`);
    return value;
  }
  if (type === "boolean") return parseBoolean(rawValue, flagName);
  return String(rawValue);
}

function assertAllowedValue(entry, value, flagName) {
  if (Array.isArray(entry.enum) && !entry.enum.includes(value)) {
    throw badInput(`--${flagName} must be one of: ${entry.enum.join(", ")}`);
  }
}

function getOption(token, optionSpec) {
  const eqIdx = token.indexOf("=");
  const rawKey = token.slice(2, eqIdx === -1 ? undefined : eqIdx);
  assertSafeKey(rawKey, "option name");
  if (!Object.hasOwn(optionSpec, rawKey)) throw badInput(`Unknown argument: --${rawKey}`);
  return {
    rawKey,
    entry: optionSpec[rawKey],
    hasInline: eqIdx !== -1,
    inlineValue: token.slice(eqIdx + 1),
  };
}

function parseOption(token, next, optionSpec) {
  const { rawKey, entry, hasInline, inlineValue } = getOption(token, optionSpec);
  const outputKey = entry.key ?? rawKey;
  assertSafeKey(outputKey, "option output key");
  const { rawValue, consumesNext } = readRawValue(
    entry.type ?? "string",
    hasInline,
    inlineValue,
    next,
    rawKey,
  );
  let value = parseValue(entry.type ?? "string", rawValue, rawKey);
  assertAllowedValue(entry, value, rawKey);
  if (typeof entry.parse === "function") value = entry.parse(value, rawKey);
  return { outputKey, value, consumesNext };
}

function assertRequiredOptions(optionSpec, out) {
  for (const [flag, entry] of Object.entries(optionSpec)) {
    if (!entry.required) continue;
    const key = entry.key ?? flag;
    assertSafeKey(key, "required option key");
    const value = out[key];
    if (value === undefined || value === null || value === "")
      throw badInput(`Missing required argument: --${flag}`);
  }
}

export function parseArgs(spec, argv) {
  const defaults = spec?.defaults ?? {};
  const optionSpec = spec?.options ?? {};
  const allowPositionals = spec?.allowPositionals === true;
  const out = Object.assign(Object.create(null), defaults);
  const positionals = [];

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      if (!allowPositionals) {
        throw badInput(`Unknown argument: ${token}`);
      }
      positionals.push(token);
      continue;
    }

    const {
      outputKey,
      value: parsedValue,
      consumesNext,
    } = parseOption(token, argv[i + 1], optionSpec);
    if (consumesNext) i++;
    out[outputKey] = parsedValue;
  }

  assertRequiredOptions(optionSpec, out);

  if (allowPositionals) {
    out._ = positionals;
  }

  return out;
}
