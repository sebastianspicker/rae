/** Measure comparable asynchronous work, event-loop delay, memory and filesystem parsing effort. */
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";
interface Counters {
  bytesRead: number;
  readCalls: number;
  parseCalls: number;
}
export interface Sample extends Counters {
  elapsedMs: number;
  rssBeforeBytes: number;
  rssAfterBytes: number;
  processMaxRssBytes: number;
  eventLoopDelayP95Ms: number;
  eventLoopDelayMaxMs: number;
  eventLoopUtilization: number;
  timerLatenessMaxMs: number;
}
export function instrumentReads() {
  let active: Counters | undefined;
  const readSync = fs.readFileSync;
  const readDescriptor = fs.readSync;
  const read = fs.promises.readFile;
  const open = fs.promises.open;
  const parse = JSON.parse;
  const count = (value: unknown) => {
    if (active) {
      active.readCalls++;
      if (typeof value === "string" || Buffer.isBuffer(value))
        active.bytesRead += Buffer.byteLength(value);
    }
  };
  fs.readFileSync = ((...args: Parameters<typeof readSync>) => {
    const result = readSync(...args);
    count(result);
    return result;
  }) as typeof readSync;
  fs.readSync = ((...args: Parameters<typeof readDescriptor>) => {
    const bytes = readDescriptor(...args);
    if (active) {
      active.readCalls++;
      active.bytesRead += bytes;
    }
    return bytes;
  }) as typeof readDescriptor;
  fs.promises.readFile = (async (...args: Parameters<typeof read>) => {
    const result = await read(...args);
    count(result);
    return result;
  }) as typeof read;
  fs.promises.open = async (...args: Parameters<typeof open>) => {
    const handle = await open(...args);
    const fileRead = handle.read.bind(handle);
    const fileReadAll = handle.readFile.bind(handle);
    handle.read = (async (...values: Parameters<typeof fileRead>) => {
      const result = await fileRead(...values);
      if (active) {
        active.readCalls++;
        active.bytesRead += result.bytesRead;
      }
      return result;
    }) as typeof fileRead;
    handle.readFile = (async (...values: Parameters<typeof fileReadAll>) => {
      const result = await fileReadAll(...values);
      count(result);
      return result;
    }) as typeof fileReadAll;
    return handle;
  };
  JSON.parse = (...args: Parameters<typeof parse>): unknown => {
    if (active) active.parseCalls++;
    return parse(...args) as unknown;
  };
  syncBuiltinESMExports();
  return {
    begin() {
      active = { bytesRead: 0, readCalls: 0, parseCalls: 0 };
    },
    end() {
      const counters = active;
      active = undefined;
      if (!counters) throw new Error("No active benchmark sample");
      return counters;
    },
    restore() {
      active = undefined;
      fs.readFileSync = readSync;
      fs.readSync = readDescriptor;
      fs.promises.readFile = read;
      fs.promises.open = open;
      JSON.parse = parse;
      syncBuiltinESMExports();
    },
  };
}
export async function measure<T>(
  operation: () => Promise<T>,
  instrumentation: ReturnType<typeof instrumentReads>,
): Promise<{ result: T; sample: Sample }> {
  const delay = monitorEventLoopDelay({ resolution: 1 });
  delay.enable();
  await sleep(5);
  delay.reset();
  const rssBeforeBytes = process.memoryUsage().rss;
  const utilization = performance.eventLoopUtilization();
  instrumentation.begin();
  const start = performance.now();
  let timerLatenessMaxMs = 0;
  let expected = start + 5;
  const heartbeat = setInterval(() => {
    const now = performance.now();
    timerLatenessMaxMs = Math.max(timerLatenessMaxMs, now - expected);
    expected = now + 5;
  }, 5);
  try {
    const result = await operation();
    const elapsedMs = performance.now() - start;
    const counters = instrumentation.end();
    const eventLoopUtilization = performance.eventLoopUtilization(utilization).utilization;
    await sleep(5);
    return {
      result,
      sample: {
        elapsedMs,
        rssBeforeBytes,
        rssAfterBytes: process.memoryUsage().rss,
        processMaxRssBytes: process.resourceUsage().maxRSS * 1024,
        eventLoopDelayP95Ms: delay.percentile(95) / 1e6,
        eventLoopDelayMaxMs: delay.max / 1e6,
        eventLoopUtilization,
        timerLatenessMaxMs,
        ...counters,
      },
    };
  } finally {
    clearInterval(heartbeat);
    delay.disable();
  }
}
export function latencyDistribution(samples: Sample[]) {
  const times = samples.map((sample) => sample.elapsedMs).sort((a, b) => a - b);
  const percentile = (p: number) => times[Math.max(0, Math.ceil(times.length * p) - 1)];
  return {
    minimumMs: times[0],
    p50Ms: percentile(0.5),
    p95Ms: percentile(0.95),
    maximumMs: times.at(-1),
  };
}
