/** Emits human output, durable lifecycle events, and JSON event records. */
import { relative } from "node:path";
import { appendRelative } from "./safe-fs.js";
import { isoUtc } from "./util.js";
import type { CliOptions, RuntimePaths } from "./types.js";

export class Logger {
  public constructor(
    private readonly paths: RuntimePaths,
    private readonly options: CliOptions,
    private readonly writable: boolean,
  ) {}

  public log(message: string): void {
    if (this.options.verbosity !== "quiet") process.stdout.write(`[ralph] ${message}\n`);
  }

  public warn(message: string): void {
    process.stderr.write(`[ralph][WARN] ${message}\n`);
  }

  public event(event: string, message = ""): void {
    const timestamp = isoUtc();
    if (this.writable) {
      appendRelative(
        this.paths.repoRoot,
        relative(this.paths.repoRoot, this.paths.eventLog).split("\\").join("/"),
        `${timestamp} ${event}${message ? ` ${message}` : ""}\n`,
      );
    }
    if (this.options.outputFormat === "json")
      process.stderr.write(`${JSON.stringify({ ts: timestamp, event, msg: message })}\n`);
  }
}
