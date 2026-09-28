/** Configuration rejects mapped private addresses and preserves secure defaults. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { assertPublicHttpsUrl, classifyHost, configSchema } from "../src/config.js";
test("mapped private IPv6 addresses cannot enter OIDC public endpoint configuration", () => {
  for (const address of [
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "0:0:0:0:0:ffff:a00:1",
    "::ffff:c0a8:101",
  ]) {
    assert.equal(classifyHost(address), "private");
    assert.throws(() => assertPublicHttpsUrl(`https://[${address}]/jwks`, "JWKS"), /private/);
  }
  assert.equal(classifyHost("::ffff:808:808"), "public");
});
test("omitted sections populate validated Node runtime and management defaults", () => {
  const config = configSchema.parse({ database: { url: "postgres://localhost/test" } });
  assert.equal(config.server.port, 8080);
  assert.equal(config.management.port, 9090);
  assert.equal(config.platform.allowInsecureAuth, false);
  assert.throws(() =>
    configSchema.parse({
      database: { url: "postgres://localhost/test" },
      management: { host: "0.0.0.0" },
    }),
  );
});
