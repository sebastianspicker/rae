/** Copies non-TypeScript browser assets beside the compiled operator modules. */
import { cpSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const outputRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = resolve(outputRoot, "..");
mkdirSync(resolve(outputRoot, "static"), { recursive: true });
mkdirSync(resolve(outputRoot, "demo"), { recursive: true });
cpSync(resolve(sourceRoot, "static", "index.html"), resolve(outputRoot, "static", "index.html"));
cpSync(resolve(sourceRoot, "static", "styles.css"), resolve(outputRoot, "static", "styles.css"));
cpSync(resolve(sourceRoot, "static", "css"), resolve(outputRoot, "static", "css"), {
  recursive: true,
});

// Self-hosted OFL typefaces and their licences.
cpSync(resolve(sourceRoot, "static", "fonts"), resolve(outputRoot, "static", "fonts"), {
  recursive: true,
});
cpSync(resolve(sourceRoot, "static", "favicon.svg"), resolve(outputRoot, "static", "favicon.svg"));
cpSync(resolve(sourceRoot, "demo", "tour.html"), resolve(outputRoot, "demo", "tour.html"));
