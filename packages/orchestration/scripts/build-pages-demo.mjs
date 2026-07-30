/** Builds the GitHub Pages demo from the canonical operator UI plus the fixture adapter. */

import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const orchestrationRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(orchestrationRoot, "../..");
const staticRoot = resolve(orchestrationRoot, "operator/static");
const demoRoot = resolve(orchestrationRoot, "operator/demo");

function parseOutput(args) {
  const index = args.indexOf("--output");
  if (index === -1) return resolve(repositoryRoot, "dist/pages-demo");
  if (!args[index + 1]) throw new Error("--output requires a directory");
  return resolve(process.cwd(), args[index + 1]);
}

function replaceOnce(source, expected, replacement) {
  const first = source.indexOf(expected);
  if (first === -1 || source.indexOf(expected, first + expected.length) !== -1) {
    throw new Error(`Expected exactly one canonical HTML anchor: ${expected}`);
  }
  return source.replace(expected, replacement);
}

const outputRoot = parseOutput(process.argv.slice(2));
rmSync(outputRoot, { recursive: true, force: true });
mkdirSync(outputRoot, { recursive: true });
cpSync(staticRoot, outputRoot, { recursive: true });
mkdirSync(resolve(outputRoot, "demo"), { recursive: true });
cpSync(resolve(demoRoot, "mock-api.js"), resolve(outputRoot, "demo/mock-api.js"));
cpSync(resolve(demoRoot, "demo.css"), resolve(outputRoot, "demo/demo.css"));

let html = readFileSync(resolve(staticRoot, "index.html"), "utf8");
html = replaceOnce(
  html,
  "RAE Evidence Dossier — local Runboard operator console for autonomous repository runs.",
  "RAE Evidence Dossier static simulation using sanitized fixture data. No command is run.",
);
html = replaceOnce(
  html,
  "<title>RAE Evidence Dossier</title>",
  "<title>RAE Evidence Dossier · Static simulation</title>",
);
html = replaceOnce(
  html,
  '<link rel="stylesheet" href="/styles.css">',
  '<link rel="stylesheet" href="./styles.css">\n    <link rel="stylesheet" href="./demo/demo.css">',
);
html = replaceOnce(
  html,
  '<script type="module" src="/app.js"></script>',
  '<script defer src="./demo/mock-api.js"></script>\n    <script type="module" src="./app.js"></script>',
);
html = replaceOnce(
  html,
  "  <body>",
  `  <body>\n    <aside class="demo-notice" role="note">\n      <strong>Static simulation</strong>\n      <span>Sanitized fixture data. No command is run and no state is saved.</span>\n      <a href="https://github.com/sebastianspicker/rae">View repository</a>\n    </aside>`,
);

writeFileSync(resolve(outputRoot, "index.html"), html);
writeFileSync(resolve(outputRoot, ".nojekyll"), "");
console.log(`Built static demo at ${outputRoot}`);
