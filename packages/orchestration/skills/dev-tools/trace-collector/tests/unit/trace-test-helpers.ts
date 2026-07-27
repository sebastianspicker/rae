/** Writes the minimal execution-trace contract needed by trace collector fixtures. */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function writeTraceSchema(workspaceRoot: string): void {
  const schemaDir = join(workspaceRoot, "contracts", "artifacts");
  mkdirSync(schemaDir, { recursive: true });
  writeFileSync(
    join(schemaDir, "execution-trace.schema.json"),
    JSON.stringify({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      required: ["ts", "run_id", "event", "phase"],
      properties: {
        ts: { type: "string" },
        run_id: { type: "string" },
        event: { type: "string" },
        phase: { type: "string" },
      },
    }),
    "utf8",
  );
}
