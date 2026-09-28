/** Own disposable catalog snapshots and protected detail reads in an isolated worker thread. */
import { parentPort, workerData } from "node:worker_threads";
import type { CatalogRequest, CatalogResponse } from "./catalog-client.js";
import { measureCatalogReads } from "./catalog-read-metrics.js";
const port = parentPort;
if (!port) throw new Error("Catalog worker requires a parent port");
const measure = measureCatalogReads(
  (workerData as { measureReads?: boolean }).measureReads === true,
);
const { CatalogIndex } = await import("./runs.js");
const catalog = new CatalogIndex();
port.on("message", async (request: CatalogRequest) => {
  const before = measure.snapshot();
  const response: CatalogResponse = { id: request.id };
  try {
    response.value =
      request.action === "page"
        ? await catalog.page(request.project, request.options)
        : await catalog.locate(request.project, request.runId, { view: request.view });
  } catch (error) {
    response.error = error instanceof Error ? error.message : "Catalog operation failed";
    if (error instanceof Error && "status" in error && typeof error.status === "number")
      response.status = error.status;
  }
  if ((workerData as { measureReads?: boolean }).measureReads) {
    const after = measure.snapshot();
    response.metrics = {
      bytesRead: after.bytesRead - before.bytesRead,
      readCalls: after.readCalls - before.readCalls,
      parseCalls: after.parseCalls - before.parseCalls,
    };
  }
  port.postMessage(response);
});
