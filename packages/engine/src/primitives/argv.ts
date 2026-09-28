/**
 * Parses shared command-line options with explicit type and input validation for orchestration scripts.
 */
interface BadInputError extends Error {
  code: "E_BAD_INPUT";
}
type ParsedScalar = string | number | boolean;
interface OptionEntry {
  key?: string;
  type?: "string" | "number" | "boolean";
  enum?: readonly ParsedScalar[];
  required?: boolean;
  parse?: (value: ParsedScalar, flag: string) => unknown;
}
type OptionSpec = Record<string, OptionEntry>;
interface ArgumentSpec {
  defaults?: Record<string, unknown>;
  options?: OptionSpec;
  allowPositionals?: boolean;
}
interface NormalizedArgumentSpec {
  defaults: Record<string, unknown>;
  options: OptionSpec;
  allowPositionals: boolean;
}
interface ParsedOption {
  rawKey: string;
  entry: OptionEntry;
  outputKey: string;
  type: "string" | "number" | "boolean";
  inlineValue?: string;
}

function badInput(message: string): BadInputError {
  const err = new Error(message) as BadInputError;
  err.code = "E_BAD_INPUT";
  return err;
}

const UNSAFE_KEYS = new Set(["__proto__", "prototype", "constructor", "toString"]);

function assertSafeKey(key: string, label: string): void {
  if (UNSAFE_KEYS.has(key)) {
    throw badInput(`${label} is not allowed: ${key}`);
  }
}

function parseBoolean(raw: string | boolean, flagName: string): boolean {
  if (typeof raw === "boolean") return raw;
  if (raw === "true" || raw === "1") return true;
  if (raw === "false" || raw === "0") return false;
  throw badInput(`Invalid boolean for --${flagName}: ${raw}`);
}

function optionToken(token: string, optionSpec: OptionSpec): ParsedOption {
  const equalsIndex = token.indexOf("=");
  const rawKey = token.slice(2, equalsIndex === -1 ? undefined : equalsIndex);
  assertSafeKey(rawKey, "option name");
  if (!Object.hasOwn(optionSpec, rawKey)) throw badInput(`Unknown argument: --${rawKey}`);
  const entry = optionSpec[rawKey];
  const outputKey = entry.key ?? rawKey;
  assertSafeKey(outputKey, "option output key");
  return {
    rawKey,
    entry,
    outputKey,
    type: entry.type ?? "string",
    inlineValue: equalsIndex === -1 ? undefined : token.slice(equalsIndex + 1),
  };
}

function optionRawValue(
  option: ParsedOption,
  next: string | undefined,
): { value: string | boolean; consumedNext: boolean } {
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

function parsedOptionValue(option: ParsedOption, rawValue: string | boolean): unknown {
  let value: ParsedScalar;
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

function validateRequiredOptions(optionSpec: OptionSpec, values: Record<string, unknown>): void {
  for (const [flag, entry] of Object.entries(optionSpec)) {
    if (!entry.required) continue;
    const outputKey = entry.key ?? flag;
    assertSafeKey(outputKey, "required option key");
    const value = values[outputKey];
    if (value === undefined || value === null || value === "") {
      throw badInput(`Missing required argument: --${flag}`);
    }
  }
}

function normalizedArgumentSpec(spec: ArgumentSpec | null | undefined): NormalizedArgumentSpec {
  const source = spec || {};
  return {
    defaults: source.defaults || {},
    options: source.options || {},
    allowPositionals: source.allowPositionals === true,
  };
}

function appendPositional(token: string, allowPositionals: boolean, positionals: string[]): void {
  if (!allowPositionals) throw badInput(`Unknown argument: ${token}`);
  positionals.push(token);
}

function consumeArguments(
  argv: readonly string[],
  optionSpec: OptionSpec,
  allowPositionals: boolean,
  values: Record<string, unknown>,
  positionals: string[],
): void {
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

export function parseArgs(
  spec: ArgumentSpec | null | undefined,
  argv: readonly string[],
): Record<string, unknown> {
  const normalized = normalizedArgumentSpec(spec);
  const out = Object.assign(Object.create(null), normalized.defaults);
  const positionals: string[] = [];
  consumeArguments(argv, normalized.options, normalized.allowPositionals, out, positionals);
  validateRequiredOptions(normalized.options, out);
  if (normalized.allowPositionals) out._ = positionals;
  return out;
}
