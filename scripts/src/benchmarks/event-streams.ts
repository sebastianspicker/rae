#!/usr/bin/env node
/** Compare full event replay with shared bounded trace subscriptions for identical concurrent clients. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, type Hash } from "node:crypto";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { projectOperatorEvents } from "@rae/engine";
import { repositoryRoot } from "../repository-files.js";
import { instrumentReads, latencyDistribution, measure, type Sample } from "./measure.js";
interface Event {
  seq: number;
  [key: string]: unknown;
}
interface Subscription {
  close(): void;
}
interface Hub {
  subscribe(
    run: { id: string; workspaceRoot: string },
    after: number,
    listener: (events: readonly Event[]) => { acceptedThrough: number },
    onError: () => void,
  ): Subscription;
}
interface TailModule {
  EventTailHub: new () => Hub;
}
function eventDigest(hash: Hash, events: readonly Event[]): number {
  for (const event of events) hash.update(`${JSON.stringify(event)}\n`);
  return events.at(-1)?.seq ?? 0;
}
function prepare(root: string, size: number): void {
  execFileSync("git", ["init", "-q", root]);
  fs.mkdirSync(join(root, ".pipeline/runs/stream-run"), { recursive: true });
  fs.writeFileSync(
    join(root, ".pipeline/pipeline-state.json"),
    JSON.stringify({ run_id: "stream-run" }),
  );
  const fd = fs.openSync(join(root, ".pipeline/runs/stream-run/trace.jsonl"), "wx", 0o600);
  try {
    for (let index = 0; index < size; index++)
      fs.writeSync(
        fd,
        `${JSON.stringify({
          run_id: "stream-run",
          ts: `2026-09-01T00:00:${String(index % 60).padStart(2, "0")}Z`,
          event: "agent_call",
          phase: "arm",
          status: "ok",
          metadata: { detail: `Unicode fixture 日本語 ${index}` },
        })}\n`,
      );
  } finally {
    fs.closeSync(fd);
  }
}
function fullReplay(root: string, cursors: number[]): string[] {
  return cursors.map((after) => {
    const events = projectOperatorEvents("stream-run", root) as Event[];
    const hash = createHash("sha256");
    eventDigest(
      hash,
      events.filter((event) => event.seq > after),
    );
    return hash.digest("hex");
  });
}
async function sharedReplay(
  module: TailModule,
  root: string,
  size: number,
  cursors: number[],
): Promise<string[]> {
  const hub = new module.EventTailHub();
  const subscriptions: Subscription[] = [];
  let deadline: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      Promise.all(
        cursors.map(
          (after) =>
            new Promise<string>((resolveClient, reject) => {
              const hash = createHash("sha256");
              const subscription = hub.subscribe(
                { id: "stream-run", workspaceRoot: root },
                after,
                (events) => {
                  const last = eventDigest(hash, events);
                  if (last === size) {
                    subscription.close();
                    resolveClient(hash.digest("hex"));
                  }
                  return { acceptedThrough: last };
                },
                () => reject(new Error("Shared event replay failed")),
              );
              subscriptions.push(subscription);
            }),
        ),
      ),
      new Promise<never>((_resolve, reject) => {
        deadline = setTimeout(
          () => reject(new Error("Shared event replay exceeded 60 seconds")),
          60_000,
        );
      }),
    ]);
  } finally {
    if (deadline) clearTimeout(deadline);
    for (const subscription of subscriptions) subscription.close();
  }
}
const instrumentation = instrumentReads();
try {
  const module = (await import(
    pathToFileURL(resolve(repositoryRoot, "apps/operator/dist/lib/tail.js")).href
  )) as TailModule;
  for (const size of [1000, 10000]) {
    const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "rae-stream-bench-")));
    try {
      prepare(root, size);
      for (const cohorts of [1, 10]) {
        const cursors = Array.from({ length: 100 }, (_value, index) =>
          Math.floor((size * (index % cohorts)) / cohorts),
        );
        const reference: Sample[] = [],
          compiled: Sample[] = [];
        let resultSha256 = "";
        for (let iteration = 0; iteration < 7; iteration++) {
          const baseline = await measure(async () => fullReplay(root, cursors), instrumentation);
          const current = await measure(
            () => sharedReplay(module, root, size, cursors),
            instrumentation,
          );
          assert.deepEqual(current.result, baseline.result);
          const digest = createHash("sha256").update(JSON.stringify(current.result)).digest("hex");
          if (resultSha256) assert.equal(digest, resultSha256);
          resultSha256 = digest;
          reference.push(baseline.sample);
          compiled.push(current.sample);
        }
        console.log(
          JSON.stringify({
            workload: "concurrent-event-replay",
            node: process.version,
            platform: process.platform,
            size,
            clients: cursors.length,
            cohorts,
            iterations: 7,
            resultSha256,
            reference: { latency: latencyDistribution(reference), samples: reference },
            shared: { latency: latencyDistribution(compiled), samples: compiled },
          }),
        );
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
} finally {
  instrumentation.restore();
}
