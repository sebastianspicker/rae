/** Bounded body fixtures cover split Unicode, byte floods and malformed UTF-8. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Readable, PassThrough } from "node:stream";
import { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import { collectBodyBytes, readJsonBody } from "../src/http-body.js";
function request(chunks: Buffer[], contentLength?: string): IncomingMessage {
  const message = new IncomingMessage(new Socket());
  if (contentLength !== undefined) message.headers["content-length"] = contentLength;
  for (const chunk of chunks) message.push(chunk);
  message.push(null);
  return message;
}
test("split Unicode is decoded once and charged as bytes", async () => {
  const bytes = Buffer.from('{"value":"雪🙂"}');
  const message = request(Array.from(bytes, (byte) => Buffer.from([byte])));
  assert.deepEqual(await readJsonBody(message, bytes.length), { value: "雪🙂" });
  await assert.rejects(readJsonBody(request([bytes]), bytes.length - 1), { status: 413 });
  await assert.rejects(readJsonBody(request([bytes], "99999999999999999999"), 100), {
    status: 413,
  });
});
test("malformed UTF-8 and JSON fail without replacement decoding", async () => {
  await assert.rejects(
    readJsonBody(request([Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d])])),
    { status: 400 },
  );
  await assert.rejects(readJsonBody(request([Buffer.from('{"value":')])), { status: 400 });
  assert.deepEqual(await readJsonBody(request([])), {});
});
test("overflow pauses consumption immediately and aborted streams reject", async () => {
  const stream = new PassThrough();
  const body = collectBodyBytes(stream, 4);
  stream.write(Buffer.from("12345"));
  await assert.rejects(body, { status: 413 });
  assert.equal(stream.isPaused(), true);
  assert.equal(stream.listenerCount("data"), 0);
  stream.destroy();
  const aborted = new PassThrough();
  const pending = collectBodyBytes(aborted, 100);
  aborted.destroy();
  await assert.rejects(pending, { status: 400 });
  await assert.rejects(collectBodyBytes(Readable.from(["decoded string"])), { status: 400 });
});
