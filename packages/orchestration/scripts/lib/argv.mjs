/**
 * Parses shared command-line options with explicit type and input validation for orchestration scripts.
 */
function badInput(message) {
  const err = new Error(message);
  err.code = "E_BAD_INPUT";
  return err;
}

function parseBoolean(raw, flagName) {
  if (typeof raw === "boolean") return raw;
  if (raw === "true" || raw === "1") return true;
  if (raw === "false" || raw === "0") return false;
  throw badInput(`Invalid boolean for --${flagName}: ${raw}`);
}

function optionToken(token, optionSpec) {
  const equalsIndex = token.indexOf("=");
  const rawKey = token.slice(2, equalsIndex === -1 ? undefined : equalsIndex);
  const entry = optionSpec[rawKey];
  if (!entry) throw badInput(`Unknown argument: --${rawKey}`);
  return {
    rawKey,
    entry,
    outputKey: entry.key ?? rawKey,
    type: entry.type ?? "string",
    inlineValue: equalsIndex === -1 ? undefined : token.slice(equalsIndex + 1),
  };
}

function optionRawValue(option, next) {
  if (option.inlineValue !== undefined) {
    return { value: option.inlineValue, consumedNext: false };
  }
  if (option.type === "boolean" && (!next || next.startsWith("--"))) {
    return { value: true, consumedNext: false };
  }
  if (!next || next.startsWith("--")) {
    throw badInput(`Missing value for --${option.rawKey}`);
  }
  return { value: next, consumedNext: true };
}

function parsedOptionValue(option, rawValue) {
  let value;
  if (option.type === "number") {
    value = Number(rawValue);
    if (!Number.isFinite(value)) {
      throw badInput(`Invalid number for --${option.rawKey}: ${rawValue}`);
    }
  } else {
    value = option.type === "boolean" ? parseBoolean(rawValue, option.rawKey) : String(rawValue);
  }

  if (Array.isArray(option.entry.enum) && !option.entry.enum.includes(value)) {
    throw badInput(`--${option.rawKey} must be one of: ${option.entry.enum.join(", ")}`);
  }
  return typeof option.entry.parse === "function"
    ? option.entry.parse(value, option.rawKey)
    : value;
}

function validateRequiredOptions(optionSpec, values) {
  for (const [flag, entry] of Object.entries(optionSpec)) {
    if (!entry.required) continue;
    const value = values[entry.key ?? flag];
    if (value === undefined || value === null || value === "") {
      throw badInput(`Missing required argument: --${flag}`);
    }
  }
}

function normalizedArgumentSpec(spec) {
  const source = spec || {};
  return {
    defaults: source.defaults || {},
    options: source.options || {},
    allowPositionals: source.allowPositionals === true,
  };
}

function appendPositional(token, allowPositionals, positionals) {
  if (!allowPositionals) throw badInput(`Unknown argument: ${token}`);
  positionals.push(token);
}

function consumeArguments(argv, optionSpec, allowPositionals, values, positionals) {
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      appendPositional(token, allowPositionals, positionals);
      continue;
    }
    const option = optionToken(token, optionSpec);
    const raw = optionRawValue(option, argv[index + 1]);
    if (raw.consumedNext) index++;
    values[option.outputKey] = parsedOptionValue(option, raw.value);
  }
}

export function parseArgs(spec, argv) {
  const normalized = normalizedArgumentSpec(spec);
  const out = { ...normalized.defaults };
  const positionals = [];
  consumeArguments(argv, normalized.options, normalized.allowPositionals, out, positionals);
  validateRequiredOptions(normalized.options, out);
  if (normalized.allowPositionals) out._ = positionals;
  return out;
}
