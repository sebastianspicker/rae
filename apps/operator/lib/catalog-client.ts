/** Keep catalog discovery and detail hydration off the HTTP event loop with bounded queued work. */
import { Worker } from "node:worker_threads";
import type { OperatorProject } from "./security.js";
import type { OperatorRun } from "../static/js/types.js";
import type { InternalRun } from "./runs.js";
import type { ReadMetrics } from "./catalog-read-metrics.js";
export interface CatalogPageOptions {
  cursor?: string | null;
  limit?: number;
  view?: "summary" | "detail";
}
export interface CatalogPage {
  runs: OperatorRun[];
  next_cursor: string | null;
}
export type CatalogRequest =
  | { id: number; action: "page"; project: OperatorProject; options: CatalogPageOptions }
  | {
      id: number;
      action: "locate";
      project: OperatorProject;
      runId: string;
      view: "summary" | "detail";
    };
export type CatalogResponse = {
  id: number;
  value?: CatalogPage | InternalRun;
  error?: string;
  status?: number;
  metrics?: ReadMetrics;
};
interface Pending {
  resolve(value: CatalogPage | InternalRun): void;
  reject(error: Error): void;
}
const MAX_PENDING = 32;
export class RunCatalog {
  private worker: Worker | undefined;
  private readonly pending = new Map<number, Pending>();
  private sequence = 0;
  private closed = false;
  private metrics: ReadMetrics = { bytesRead: 0, readCalls: 0, parseCalls: 0 };
  constructor(private readonly options: { measureReads?: boolean } = {}) {}

  async page(project: OperatorProject, options: CatalogPageOptions = {}): Promise<CatalogPage> {
    const result = await this.request({ id: ++this.sequence, action: "page", project, options });
    if (!("runs" in result) || !Array.isArray(result.runs))
      throw new Error("Invalid catalog page response");
    return result as CatalogPage;
  }
  async locate(
    project: OperatorProject,
    runId: string,
    { view = "detail" }: { view?: "summary" | "detail" } = {},
  ): Promise<InternalRun> {
    const result = await this.request({
      id: ++this.sequence,
      action: "locate",
      project,
      runId,
      view,
    });
    if (!("workspaceRoot" in result)) throw new Error("Invalid catalog run response");
    return result;
  }
  takeReadMetrics(): ReadMetrics {
    const result = this.metrics;
    this.metrics = { bytesRead: 0, readCalls: 0, parseCalls: 0 };
    return result;
  }
  private request(request: CatalogRequest): Promise<CatalogPage | InternalRun> {
    if (this.closed) return Promise.reject(new Error("run catalog is closed"));
    if (this.pending.size >= MAX_PENDING)
      return Promise.reject(Object.assign(new Error("run catalog is busy"), { status: 503 }));
    const worker = this.worker ?? this.start();
    return new Promise((resolve, reject) => {
      this.pending.set(request.id, { resolve, reject });
      worker.ref();
      try {
        worker.postMessage(request);
      } catch (error) {
        this.pending.delete(request.id);
        if (!this.pending.size) worker.unref();
        reject(error);
      }
    });
  }
  private start(): Worker {
    const worker = new Worker(new URL("./catalog-worker.js", import.meta.url), {
      workerData: { measureReads: this.options.measureReads === true },
      resourceLimits: { maxOldGenerationSizeMb: 256 },
    });
    this.worker = worker;
    worker.on("message", (response: CatalogResponse) => {
      const pending = this.pending.get(response.id);
      if (!pending) return;
      this.pending.delete(response.id);
      if (response.metrics)
        for (const key of ["bytesRead", "readCalls", "parseCalls"] as const)
          this.metrics[key] += response.metrics[key];
      if (response.error)
        pending.reject(Object.assign(new Error(response.error), { status: response.status }));
      else if (response.value) pending.resolve(response.value);
      else pending.reject(new Error("Catalog worker returned no result"));
      if (!this.pending.size) worker.unref();
    });
    worker.once("error", (error) =>
      this.fail(worker, error instanceof Error ? error : new Error("Catalog worker failed")),
    );
    worker.once("exit", (code) => this.fail(worker, new Error(`Catalog worker exited (${code})`)));
    worker.unref();
    return worker;
  }
  private fail(worker: Worker, error: Error): void {
    if (this.worker !== worker) return;
    this.worker = undefined;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
  async close(): Promise<void> {
    this.closed = true;
    const worker = this.worker;
    if (!worker) return;
    this.fail(worker, new Error("run catalog is closed"));
    await worker.terminate();
  }
}
