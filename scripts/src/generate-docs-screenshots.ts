#!/usr/bin/env node
/** Render deterministic terminal SVGs from the compiled public CLI's live help output. */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { repositoryRoot } from "./repository-files.js";
interface Capture {
  filename: string;
  title: string;
  prompt: string;
  args: string[];
}
const captures: Capture[] = [
  {
    filename: "rae-cli.svg",
    title: "RAE command map",
    prompt: "$ npm run rae -- --help",
    args: ["--help"],
  },
  {
    filename: "rae-agent-safety.svg",
    title: "RAE autonomous agent safety defaults",
    prompt: "$ npm run rae -- agent --help",
    args: ["agent", "--help"],
  },
];
function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#x27;");
}
export function wrapLines(output: string): string[] {
  return output.split(/\r?\n/).flatMap((line) => {
    if (!line) return [""];
    const lines: string[] = [];
    let remaining = line;
    while (Array.from(remaining).length > 118) {
      const characters = Array.from(remaining);
      const candidate = characters.slice(0, 118).join("");
      const boundaries = [...candidate.matchAll(/\s+|(?<=[\p{L}\p{N}])-+(?=[\p{L}\p{N}])/gu)];
      const boundary = boundaries.at(-1);
      const split =
        boundary && boundary.index > 4 ? boundary.index + boundary[0].length : candidate.length;
      lines.push(remaining.slice(0, split));
      remaining = `    ${remaining.slice(split)}`;
    }
    lines.push(remaining);
    return lines;
  });
}
export function renderSvg(capture: Pick<Capture, "title" | "prompt">, output: string): string {
  const lines = [capture.prompt, "", ...wrapLines(output)];
  const width = Math.min(
    1600,
    Math.max(960, Math.max(...lines.map((line) => Array.from(line).length)) * 9 + 80),
  );
  const height = 88 + lines.length * 22;
  const text = lines
    .map(
      (line, index) =>
        `    <text x="32" y="${76 + index * 22}" class="line">${escapeXml(line)}</text>`,
    )
    .join("\n");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title description">\n  <title id="title">${escapeXml(capture.title)}</title>\n  <desc id="description">Deterministic terminal capture generated from the live RAE CLI.</desc>\n  <style>\n    .line { fill: #e6edf3; font: 14px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }\n    .chrome { fill: #8b949e; font: 13px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }\n  </style>\n  <rect width="${width}" height="${height}" rx="14" fill="#0d1117"/>\n  <rect width="${width}" height="44" rx="14" fill="#161b22"/>\n  <circle cx="24" cy="22" r="6" fill="#ff5f56"/>\n  <circle cx="44" cy="22" r="6" fill="#ffbd2e"/>\n  <circle cx="64" cy="22" r="6" fill="#27c93f"/>\n  <text x="88" y="27" class="chrome">${escapeXml(capture.title)}</text>\n${text}\n</svg>\n`;
}
export function generateScreenshots(check: boolean): number {
  const expected = captures.map((capture) => {
    const output = execFileSync(
      process.execPath,
      [resolve(repositoryRoot, "scripts/dist/rae.js"), ...capture.args],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
        env: { ...process.env, LANG: "C", LC_ALL: "C", NO_COLOR: "1" },
      },
    )
      .replaceAll(repositoryRoot, "/path/to/rae")
      .trimEnd();
    return {
      path: resolve(repositoryRoot, "docs/assets/screenshots", capture.filename),
      svg: renderSvg(capture, output),
    };
  });
  let stale = 0;
  for (const { path, svg } of expected) {
    if (check) {
      if (!existsSync(path) || readFileSync(path, "utf8") !== svg) {
        console.error(`stale generated screenshot: ${path.slice(repositoryRoot.length + 1)}`);
        stale++;
      }
    } else {
      mkdirSync(resolve(repositoryRoot, "docs/assets/screenshots"), { recursive: true });
      writeFileSync(path, svg);
    }
  }
  return stale ? 1 : 0;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.slice(2).some((arg) => arg !== "--check"))
      throw new Error("Usage: generate-docs-screenshots [--check]");
    process.exitCode = generateScreenshots(process.argv.includes("--check"));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
