/** Builds the static, browser-only operator demo for a GitHub Pages subpath. */

import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { tmpdir } from "node:os";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const operatorDirectory = resolve(scriptDirectory, "..");
const sourceOperatorDirectory =
  basename(operatorDirectory) === "dist" ? resolve(operatorDirectory, "..") : operatorDirectory;
const staticDirectory = resolve(operatorDirectory, "static");
const demoDirectory = resolve(operatorDirectory, "demo");
const screenshotsDirectory = resolve(sourceOperatorDirectory, "docs", "screenshots");
const defaultOutput = resolve(tmpdir(), "rae-operator-pages-demo");

function parseOutput(argv: string[]): string {
  if (argv.length === 0) return defaultOutput;
  if (argv.length === 2 && argv[0] === "--out") return resolve(argv[1]);
  throw new Error("usage: build-demo.mjs [--out <directory>]");
}

function assertSafeOutput(outputDirectory: string): void {
  const outputContainsSource = !relative(outputDirectory, operatorDirectory).startsWith("..");
  const sourceContainsOutput = !relative(operatorDirectory, outputDirectory).startsWith("..");
  if (
    !isAbsolute(outputDirectory) ||
    outputDirectory === resolve("/") ||
    outputContainsSource ||
    sourceContainsOutput
  ) {
    throw new Error("demo output must be a dedicated directory outside the operator source");
  }
}

function pagesIndex(source: string): string {
  return source
    .replace('href="/favicon.svg"', 'href="./favicon.svg"')
    .replace('href="/styles.css"', 'href="./styles.css"')
    .replace('src="/app.js"', 'src="./demo/bootstrap.js"')
    .replace(
      "and no live or publish controls.",
      'and no live or publish controls. <a href="./demo/tour.html">Open the screenshot tour</a>.',
    );
}

/** Copies the real static assets and injects only the mock bootstrap for Pages. */
export async function buildDemo(outputDirectory = defaultOutput): Promise<string> {
  const output = resolve(outputDirectory);
  assertSafeOutput(output);
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  await cp(staticDirectory, output, { recursive: true });
  await cp(demoDirectory, resolve(output, "demo"), { recursive: true });
  await cp(screenshotsDirectory, resolve(output, "demo", "screenshots"), { recursive: true });
  const bootstrapPath = resolve(output, "demo", "bootstrap.js");
  await writeFile(
    bootstrapPath,
    (await readFile(bootstrapPath, "utf8")).replaceAll("../static/", "../"),
  );
  await writeFile(
    resolve(output, "index.html"),
    pagesIndex(await readFile(resolve(staticDirectory, "index.html"), "utf8")),
  );
  await writeFile(resolve(output, ".nojekyll"), "");
  return output;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const output = await buildDemo(parseOutput(process.argv.slice(2)));
  process.stdout.write(`Built browser-only operator demo in ${output}\n`);
}
