/** Purpose: prove the worker control plane accepts only globally routable addresses. */
import assert from "node:assert/strict";
import test from "node:test";
import { createWorkerRequest } from "../src/worker.mjs";

const NON_GLOBAL_ADDRESSES = [
  "0.0.0.1",
  "10.0.0.1",
  "100.64.0.1",
  "127.0.0.1",
  "169.254.1.1",
  "172.16.0.1",
  "192.0.0.1",
  "192.0.2.1",
  "192.88.99.1",
  "192.168.0.1",
  "198.18.0.1",
  "198.51.100.1",
  "203.0.113.1",
  "224.0.0.1",
  "240.0.0.1",
  "::",
  "::1",
  "::ffff:7f00:1",
  "64:ff9b::7f00:1",
  "64:ff9b:1::1",
  "100::1",
  "2001::1",
  "2001:db8::1",
  "2002::1",
  "3fff::1",
  "5f00::1",
  "fc00::1",
  "fe80::1",
  "ff00::1",
];

test("worker rejects every non-global resolver answer before a request", async () => {
  for (const address of NON_GLOBAL_ADDRESSES) {
    await assert.rejects(
      createWorkerRequest({
        baseUrl: "https://control.example/",
        token: "test-token",
        resolveHostname: async () => [{ address, family: address.includes(":") ? 6 : 4 }],
        fetchImpl: async () => {
          throw new Error("non-global addresses must be rejected before fetch");
        },
      }),
      /resolve only to public addresses/,
      address,
    );
  }
});

test("worker accepts representative globally routable IPv4 and IPv6 answers", async () => {
  for (const address of ["1.1.1.1", "2606:4700:4700::1111"]) {
    const request = await createWorkerRequest({
      baseUrl: "https://control.example/",
      token: "test-token",
      resolveHostname: async () => [{ address, family: address.includes(":") ? 6 : 4 }],
      fetchImpl: async () => ({ ok: true, status: 200 }),
    });

    const response = await request("/api/v2/workers/worker/claim", {}, "idempotency-key");
    assert.equal(response.status, 200);
  }
});
