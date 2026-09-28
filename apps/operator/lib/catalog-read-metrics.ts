/** Optional worker-local JavaScript I/O counters for sequential catalog benchmarks. */
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
export interface ReadMetrics {
  bytesRead: number;
  readCalls: number;
  parseCalls: number;
}
export function measureCatalogReads(enabled: boolean): { snapshot(): ReadMetrics } {
  const metrics = { bytesRead: 0, readCalls: 0, parseCalls: 0 };
  if (enabled) {
    const readFile = fs.readFileSync;
    const read = fs.readSync;
    const readAsync = fs.promises.readFile;
    const parse = JSON.parse;
    const count = (value: string | Buffer) => {
      metrics.readCalls++;
      metrics.bytesRead += Buffer.byteLength(value);
    };
    fs.readFileSync = ((...args: Parameters<typeof readFile>) => {
      const value = readFile(...args);
      count(value);
      return value;
    }) as typeof readFile;
    fs.readSync = ((...args: Parameters<typeof read>) => {
      const size = read(...args);
      metrics.readCalls++;
      metrics.bytesRead += size;
      return size;
    }) as typeof read;
    fs.promises.readFile = (async (...args: Parameters<typeof readAsync>) => {
      const value = await readAsync(...args);
      count(value);
      return value;
    }) as typeof readAsync;
    JSON.parse = (...args: Parameters<typeof parse>): unknown => {
      metrics.parseCalls++;
      return parse(...args) as unknown;
    };
    syncBuiltinESMExports();
  }
  return { snapshot: () => ({ ...metrics }) };
}
