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

export function parseArgs(spec, argv) {
  const defaults = spec?.defaults ?? {};
  const optionSpec = spec?.options ?? {};
  const allowPositionals = spec?.allowPositionals === true;
  const out = { ...defaults };
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

    const eqIdx = token.indexOf("=");
    const rawKey = token.slice(2, eqIdx === -1 ? undefined : eqIdx);
    const specEntry = optionSpec[rawKey];
    if (!specEntry) {
      throw badInput(`Unknown argument: --${rawKey}`);
    }

    const outputKey = specEntry.key ?? rawKey;
    const type = specEntry.type ?? "string";
    const hasInline = eqIdx !== -1;
    const inlineValue = hasInline ? token.slice(eqIdx + 1) : undefined;
    const next = argv[i + 1];

    let rawValue;
    if (type === "boolean") {
      if (hasInline) {
        rawValue = inlineValue;
      } else if (next && !next.startsWith("--")) {
        rawValue = next;
        i++;
      } else {
        rawValue = true;
      }
    } else if (hasInline) {
      rawValue = inlineValue;
    } else {
      if (!next || next.startsWith("--")) {
        throw badInput(`Missing value for --${rawKey}`);
      }
      rawValue = next;
      i++;
    }

    let parsedValue;
    if (type === "number") {
      parsedValue = Number(rawValue);
      if (!Number.isFinite(parsedValue)) {
        throw badInput(`Invalid number for --${rawKey}: ${rawValue}`);
      }
    } else if (type === "boolean") {
      parsedValue = parseBoolean(rawValue, rawKey);
    } else {
      parsedValue = String(rawValue);
    }

    if (Array.isArray(specEntry.enum) && !specEntry.enum.includes(parsedValue)) {
      throw badInput(`--${rawKey} must be one of: ${specEntry.enum.join(", ")}`);
    }

    if (typeof specEntry.parse === "function") {
      parsedValue = specEntry.parse(parsedValue, rawKey);
    }

    out[outputKey] = parsedValue;
  }

  for (const [flag, entry] of Object.entries(optionSpec)) {
    if (!entry.required) continue;
    const key = entry.key ?? flag;
    const value = out[key];
    if (value === undefined || value === null || value === "") {
      throw badInput(`Missing required argument: --${flag}`);
    }
  }

  if (allowPositionals) {
    out._ = positionals;
  }

  return out;
}
