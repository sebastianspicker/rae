/** Collect bounded raw request bytes and decode UTF-8 exactly once before JSON validation. */
import type { IncomingMessage } from "node:http";
import type { Readable } from "node:stream";
export const MAX_HTTP_BODY_BYTES = 1_050_000;
export class HttpBodyError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}
export function collectBodyBytes(stream: Readable, maximum = MAX_HTTP_BODY_BYTES): Promise<Buffer> {
  if (!Number.isSafeInteger(maximum) || maximum < 0) throw new Error("Invalid HTTP body bound");
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    let settled = false;
    const cleanup = (): void => {
      stream.off("data", onData);
      stream.off("end", onEnd);
      stream.off("error", onError);
      stream.off("aborted", onAbort);
      stream.off("close", onClose);
    };
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      stream.pause();
      cleanup();
      reject(error);
    };
    const onData = (chunk: unknown): void => {
      if (!Buffer.isBuffer(chunk)) {
        fail(new HttpBodyError("HTTP body must supply raw bytes", 400));
        return;
      }
      size += chunk.byteLength;
      if (size > maximum) {
        fail(new HttpBodyError("Request body exceeds byte limit", 413));
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(Buffer.concat(chunks, size));
    };
    const onError = (error: Error): void => fail(error);
    const onAbort = (): void => fail(new HttpBodyError("Request body was aborted", 400));
    const onClose = (): void => {
      if (!stream.readableEnded) onAbort();
    };
    stream.on("data", onData);
    stream.once("end", onEnd);
    stream.once("error", onError);
    stream.once("aborted", onAbort);
    stream.once("close", onClose);
    if (stream.destroyed && !stream.readableEnded) onAbort();
    else if (stream.readableEnded) onEnd();
  });
}
export async function readJsonBody(
  req: IncomingMessage,
  maximum = MAX_HTTP_BODY_BYTES,
): Promise<unknown> {
  const declared = req.headers["content-length"];
  if (
    declared !== undefined &&
    (!/^(?:0|[1-9][0-9]*)$/.test(declared) || BigInt(declared) > BigInt(maximum))
  )
    throw new HttpBodyError("Request body exceeds byte limit", 413);
  const bytes = await collectBodyBytes(req, maximum);
  if (!bytes.length) return {};
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
    ) as unknown;
  } catch {
    throw new HttpBodyError("Request body must contain valid UTF-8 JSON", 400);
  }
}
