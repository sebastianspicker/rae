#!/usr/bin/env node
/** Execute declarative CI argument arrays without a shell, including before the first build. */
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

export function parseCommands(source: string): string[][] {
  const parsed: unknown = JSON.parse(source);
  if (!Array.isArray(parsed) || !parsed.length)
    throw new Error("CI step must contain argument arrays");
  const commands: unknown[] = typeof parsed[0] === "string" ? [parsed] : parsed;
  return commands.map((command) => {
    if (
      !Array.isArray(command) ||
      !command.length ||
      command.some((arg: unknown) => typeof arg !== "string" || arg.includes("\0"))
    )
      throw new Error("CI arguments must be nonempty arrays of strings");
    return command as string[];
  });
}
export async function runCommands(commands: readonly string[][]): Promise<void> {
  for (const [executable, ...args] of commands) {
    if (!executable) throw new Error("CI executable is required");
    await new Promise<void>((resolve, reject) => {
      const child = spawn(executable === "node" ? process.execPath : executable, args, {
        stdio: "inherit",
      });
      const interrupt = () => child.kill("SIGINT");
      const terminate = () => child.kill("SIGTERM");
      process.on("SIGINT", interrupt);
      process.on("SIGTERM", terminate);
      const cleanup = () => {
        process.off("SIGINT", interrupt);
        process.off("SIGTERM", terminate);
      };
      child.once("error", (error) => {
        cleanup();
        reject(error);
      });
      child.once("close", (code, signal) => {
        cleanup();
        if (code === 0) resolve();
        else reject(new Error(`${executable} failed (${signal ?? code})`));
      });
    });
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const file = process.argv[2];
    if (!file) throw new Error("CI step file is required");
    await runCommands(parseCommands(readFileSync(file, "utf8")));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
