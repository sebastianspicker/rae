/** Validate local Markdown references and anchors within an explicit repository boundary. */
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, matchesGlob, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

function inside(root: string, target: string): boolean {
  const value = relative(root, target);
  return value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value);
}
function canonical(path: string): string {
  const parts: string[] = [];
  while (!existsSync(path)) {
    parts.unshift(basename(path));
    const parent = dirname(path);
    if (path === parent) break;
    path = parent;
  }
  return resolve(realpathSync(path), ...parts);
}
function withoutFences(text: string): string {
  let fence = "";
  return text
    .split(/\r?\n/)
    .filter((line) => {
      const match = line.trim().match(/^(`{3,}|~{3,})/);
      if (match) {
        if (!fence) fence = match[1];
        else if (match[1][0] === fence[0] && match[1].length >= fence.length) fence = "";
        return false;
      }
      return !fence;
    })
    .join("\n");
}
function slug(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_\s-]/gu, "")
    .replace(/\s+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "");
}
function anchors(path: string): Set<string> {
  if (!existsSync(path) || !statSync(path).isFile()) return new Set();
  const source = withoutFences(readFileSync(path, "utf8"));
  const result = new Set<string>();
  for (const match of source.matchAll(/^\s{0,3}#{1,6}\s+(.+?)\s*$/gm)) {
    const explicit = match[1].match(/\{#([^}]+)\}\s*$/);
    result.add(explicit ? explicit[1] : slug(match[1]));
  }
  for (const match of source.matchAll(/<(?:a|h[1-6])\s+[^>]*(?:id|name)=["']([^"']+)["']/g))
    result.add(match[1]);
  return result;
}
function markdownFiles(root: string, excludes: string[]): string[] {
  function walk(directory: string): string[] {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory()
        ? walk(resolve(directory, entry.name))
        : entry.isFile() && entry.name.endsWith(".md")
          ? [resolve(directory, entry.name)]
          : [],
    );
  }
  return [
    resolve(root, "README.md"),
    resolve(root, "CONTRIBUTING.md"),
    ...(existsSync(resolve(root, "docs")) ? walk(resolve(root, "docs")) : []),
  ].filter(
    (path) =>
      existsSync(path) && !excludes.some((pattern) => matchesGlob(relative(root, path), pattern)),
  );
}
function target(raw: string): string {
  const value = raw.trim();
  if (value.startsWith("<")) return value.slice(1, value.indexOf(">"));
  return value.split(/\s+/)[0];
}
export function checkMarkdown(
  root: string,
  allowedRoot: string,
  strict: boolean,
  excludes: string[],
): { count: number; errors: string[] } {
  root = canonical(root);
  allowedRoot = canonical(allowedRoot);
  if (!inside(allowedRoot, root)) throw new Error("Root must be within allowed root");
  const files = markdownFiles(root, excludes),
    errors: string[] = [];
  const anchorCache = new Map<string, Set<string>>();
  function check(path: string, raw: string): void {
    const value = target(raw);
    if (!value) {
      errors.push(`${relative(root, path)}: empty target`);
      return;
    }
    if (/^(?:\/\/|[a-zA-Z][a-zA-Z0-9+.-]*:)/.test(value)) return;
    const [pathPart, fragment = ""] = value.split("#");
    const destination = pathPart
      ? canonical(resolve(dirname(path), decodeURIComponent(pathPart)))
      : path;
    if (!inside(allowedRoot, destination)) {
      errors.push(`${relative(root, path)}: target escapes repository root: ${value}`);
      return;
    }
    if (!existsSync(destination)) {
      errors.push(`${relative(root, path)}: missing target: ${value}`);
      return;
    }
    if (strict && fragment) {
      let values = anchorCache.get(destination);
      if (!values) {
        values = anchors(destination);
        anchorCache.set(destination, values);
      }
      if (!values.has(decodeURIComponent(fragment)))
        errors.push(
          `${relative(root, path)}: missing anchor '#${fragment}' in ${relative(root, destination)}`,
        );
    }
  }
  for (const path of files) {
    const source = withoutFences(readFileSync(path, "utf8"));
    const normalize = (value: string): string => value.trim().toLowerCase().replace(/\s+/g, " ");
    const definitions = new Map(
      [...source.matchAll(/^\s*\[([^\]]+)\]:\s*(\S+)\s*$/gm)].map((match) => [
        normalize(match[1]),
        match[2],
      ]),
    );
    for (const match of source.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)) check(path, match[1]);
    for (const match of source.matchAll(/(?<!!)\[([^\]]+)\]\[([^\]]*)\]/g)) {
      const label = normalize(match[2] || match[1]),
        value = definitions.get(label);
      if (value === undefined)
        errors.push(`${relative(root, path)}: missing reference definition [${label}]`);
      else check(path, value);
    }
  }
  return { count: files.length, errors: [...new Set(errors)].sort() };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { values } = parseArgs({
      options: {
        root: { type: "string", default: "." },
        "allowed-root": { type: "string" },
        strict: { type: "boolean", default: false },
        exclude: { type: "string", multiple: true, default: [] },
      },
    });
    const result = checkMarkdown(
      resolve(values.root),
      resolve(values["allowed-root"] ?? values.root),
      values.strict,
      values.exclude,
    );
    console.log(
      result.errors.length
        ? `FAIL: markdown links\n${result.errors.join("\n")}`
        : `OK: markdown links validated across ${result.count} file(s)`,
    );
    process.exitCode = result.errors.length ? 1 : result.count ? 0 : 2;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}
