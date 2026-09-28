#!/usr/bin/env node
/** Explicit profile installation/removal CLI backed by manifest-v2 transactions. */
import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { install, uninstall } from "./profile.js";

export async function main(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      force: { type: "boolean", default: false },
      "profile-root": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    console.log("Usage: profile <install|uninstall> [--force] [--profile-root PATH] <target>");
    return 0;
  }
  if (positionals.length !== 2 || !["install", "uninstall"].includes(positionals[0]))
    throw new Error("Expected install|uninstall and one target path");
  const [action, raw] = positionals;
  const target = resolve(raw);
  if (action === "uninstall" && !existsSync(target)) {
    console.log(`no installed profile found in ${target}`);
    return 0;
  }
  // Do not canonicalize the caller's target: a symlink target must be refused.
  if (action === "install") {
    const profile = realpathSync(values["profile-root"] ?? resolve(import.meta.dirname, ".."));
    await install(profile, target, values.force);
    console.log(`installed profile into ${target}`);
  } else
    console.log(
      (await uninstall(target))
        ? `removed profile from ${target}`
        : `no installed profile found in ${target}`,
    );
  return 0;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    console.error(
      `refusing profile operation: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
