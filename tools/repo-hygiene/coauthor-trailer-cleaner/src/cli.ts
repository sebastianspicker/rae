#!/usr/bin/env node
/** Validated configuration and explicit mutation modes for the history cleaner. */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { rewriteRepository, type Repository, type RewriteOptions } from "./git.js";
import type { Target } from "./objects.js";
import { caseFold, trimIdentity, identityPattern, emailPattern } from "./identity.js";

type ObjectValue = Record<string, unknown>;
function object(value: unknown, keys: string[], label: string): ObjectValue {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label} must be an object`);
  const result = value as ObjectValue;
  for (const key of Object.keys(result))
    if (!keys.includes(key)) throw new Error(`Unsupported ${label} key: ${key}`);
  return result;
}
function string(value: unknown, label: string): string {
  if (typeof value !== "string" || /\p{Surrogate}/u.test(value) || !trimIdentity(value))
    throw new Error(`${label} must be a non-empty string`);
  return value;
}
export function normalizeTargets(value: unknown): Target[] {
  if (!Array.isArray(value) || !value.length) throw new Error("targets must be a non-empty array");
  const seen = new Set<string>();
  return value.flatMap((item) => {
    const target = object(item, ["name", "email"], "target");
    const name = trimIdentity(string(target.name, "target name")),
      email = string(target.email, "target email");
    if (emailPattern.exec(email)?.[0] !== email) throw new Error("Invalid target email");
    const key = JSON.stringify([caseFold(name), caseFold(email)]);
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ name, email }];
  });
}
function repositories(value: unknown): Repository[] {
  if (!Array.isArray(value)) throw new Error("repos must be an array");
  return value.map((item) => {
    const repo = object(item, ["url", "path"], "repo");
    return { url: string(repo.url, "repo URL"), path: string(repo.path, "repo path") };
  });
}
const help = `Usage: coauthor-trailer-cleaner [OPTIONS] [<github_repo_url> <absolute_local_repo_path> ...]
  --dry-run             Inspect without changing history
  --push                Push with an exact upstream OID lease
  --no-push             Rewrite locally only (default)
  --validate-only       Validate inputs without rewriting
  --target "Name <email>"  Remove an identity; repeatable
  --config <file>       Load JSON defaults, targets and repos
  --repos-file <file>   Load JSON repos or "url path" lines
  --backup-remote <name>  Retain the current recovery branch remotely
  --quiet | --verbose  Select output detail
  --version | --help   Show version or help
`;

export function main(args: string[]): number {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(help);
    return 0;
  }
  if (args.includes("--version")) {
    console.log("coauthor-trailer-cleaner 3.0.0");
    return 0;
  }
  if (Number(process.versions.node.split(".")[0]) < 24)
    throw new Error("Node.js 24 or newer required");
  const options: RewriteOptions = {
    targets: [{ name: "Cursor", email: "cursoragent@cursor.com" }],
    dryRun: false,
    validateOnly: false,
    noPush: true,
    backupRemote: "",
  };
  let repos: Repository[] = [],
    reposFile = "",
    quiet = false;
  const positionals: string[] = [],
    identities: Target[] = [];
  const configIndex = args.lastIndexOf("--config");
  if (configIndex >= 0) {
    const configPath = args[configIndex + 1];
    if (!configPath) throw new Error("--config requires a path");
    const config = object(
      JSON.parse(
        new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(readFileSync(configPath)),
      ),
      ["defaults", "targets", "repos"],
      "config",
    );
    const defaults = object(
      config.defaults === undefined ? {} : config.defaults,
      ["dryRun", "noPush", "backupRemote"],
      "defaults",
    );
    for (const key of ["dryRun", "noPush"] as const)
      if (Object.hasOwn(defaults, key)) {
        if (typeof defaults[key] !== "boolean") throw new Error(`defaults.${key} must be boolean`);
        options[key] = defaults[key];
      }
    if (defaults.backupRemote !== undefined && defaults.backupRemote !== null)
      options.backupRemote = string(defaults.backupRemote, "backupRemote");
    if (config.targets !== undefined && config.targets !== null)
      options.targets = normalizeTargets(config.targets);
    if (config.repos !== undefined && config.repos !== null) repos = repositories(config.repos);
  }
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    const value = (): string => {
      const next = args[++index];
      if (!next) throw new Error(`${argument} requires a value`);
      return next;
    };
    switch (argument) {
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--push":
        options.noPush = false;
        break;
      case "--no-push":
        options.noPush = true;
        break;
      case "--validate-only":
        options.validateOnly = true;
        break;
      case "--quiet":
      case "-q":
        quiet = true;
        break;
      case "--verbose":
      case "-v":
        quiet = false;
        break;
      case "--config":
        value();
        break;
      case "--repos-file":
        reposFile = value();
        break;
      case "--backup-remote":
        options.backupRemote = value();
        break;
      case "--target": {
        const match = value().match(identityPattern);
        if (!match) throw new Error('--target expects "Name <email>"');
        identities.push({ name: trimIdentity(match[1]), email: match[2] });
        break;
      }
      default:
        if (argument.startsWith("-")) throw new Error(`Unsupported option ${argument}`);
        positionals.push(argument);
    }
  }
  if (identities.length) options.targets = normalizeTargets(identities);
  if (options.backupRemote && !/^[a-zA-Z0-9_.-]+$/.test(options.backupRemote))
    throw new Error("Invalid backup remote name");
  if (!repos.length && reposFile) {
    const content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
      .decode(readFileSync(reposFile))
      .trim();
    if (/^[{[]/.test(content)) repos = repositories(JSON.parse(content));
    else
      repos = content.split(/\r?\n/).flatMap((line) => {
        if (!line.trim() || line.trimStart().startsWith("#")) return [];
        const match = line.trim().match(/^(\S+)\s+(.+)$/);
        if (!match) {
          console.error("[warn] Repos file line must be 'url path'");
          return [];
        }
        return [{ url: match[1], path: match[2] }];
      });
  }
  if (!repos.length && positionals.length) {
    if (positionals.length % 2) throw new Error("Repo list must contain URL/path pairs");
    for (let index = 0; index < positionals.length; index += 2)
      repos.push({ url: positionals[index], path: positionals[index + 1] });
  }
  if (!repos.length) throw new Error("No repos specified");
  let failures = 0;
  for (const repo of repos) {
    try {
      const result = rewriteRepository(repo, options);
      console.log(
        quiet ? `[ok] ${repo.url}` : JSON.stringify({ repository: repo.path, ...result }),
      );
      if (result.invalidatedSignatures)
        console.error(
          `[warn] Removed ${result.invalidatedSignatures} signatures invalidated by rewritten commits`,
        );
    } catch (error) {
      failures++;
      console.error(`[error] ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  console.log(failures ? `Done. ${failures}/${repos.length} failed.` : "Done.");
  return failures ? 1 : 0;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
