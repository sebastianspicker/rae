/** Purpose: adversarial filesystem and loopback-only startup contracts for the hosted platform. */
import assert from "node:assert/strict";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { isLiteralLoopbackHost, loadConfig } from "../src/config.mjs";
import { prepareHostedAttempt } from "../src/local-executor.mjs";

function temporaryDirectory(t, prefix) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function makeRuntimePath(root, through, createTarget = false) {
  const segments = [".pipeline", "hosted-worker", "run", "attempt"];
  const index = segments.indexOf(through);
  const directorySegments = segments.slice(0, index + (createTarget ? 1 : 0));
  if (directorySegments.length)
    mkdirSync(join(root, ...directorySegments), { recursive: true, mode: 0o700 });
  return join(root, ...segments.slice(0, index + 1));
}

test("hosted executor rejects symlink substitutions at every artifact component", (t) => {
  for (const component of [".pipeline", "hosted-worker", "run", "attempt", "schema"]) {
    const directory = temporaryDirectory(t, `rae-hosted-${component.replace(/[^a-z]/g, "")}-`);
    const root = join(directory, "project");
    const outside = join(directory, "outside");
    mkdirSync(root, { mode: 0o700 });
    mkdirSync(outside, { mode: 0o700 });
    const target =
      component === "schema"
        ? join(makeRuntimePath(root, "attempt", true), "output.schema.json")
        : makeRuntimePath(root, component);
    symlinkSync(outside, target);
    assert.throws(
      () => prepareHostedAttempt(resolve(root), "run", "attempt", { type: "object" }),
      /non-symlink|already exists/,
      component,
    );
    assert.equal(lstatSync(outside).isDirectory(), true);
  }
});

test("hosted executor creates private artifacts and detects replacement before spawn", (t) => {
  const directory = temporaryDirectory(t, "rae-hosted-runtime-");
  const root = resolve(join(directory, "project"));
  const outside = join(directory, "outside");
  mkdirSync(root, { mode: 0o700 });
  mkdirSync(outside, { mode: 0o700 });
  const runtime = prepareHostedAttempt(root, "run", "attempt", { type: "object" });
  assert.equal(lstatSync(runtime.attemptRoot).mode & 0o077, 0);
  assert.equal(lstatSync(runtime.schemaPath).mode & 0o077, 0);
  rmSync(runtime.attemptRoot, { recursive: true });
  symlinkSync(outside, runtime.attemptRoot);
  assert.throws(() => runtime.assertIntact(), /non-symlink|changed/);
});

test("hosted executor rejects preexisting runtime directories that are not owner-only", (t) => {
  const directory = temporaryDirectory(t, "rae-hosted-mode-");
  const root = resolve(join(directory, "project"));
  mkdirSync(join(root, ".pipeline"), { recursive: true, mode: 0o700 });
  chmodSync(join(root, ".pipeline"), 0o755);
  assert.throws(
    () => prepareHostedAttempt(root, "run", "attempt", { type: "object" }),
    /owner-only/,
  );
});

function configDocument({
  host,
  publicBaseUrl,
  insecure = false,
  allowInsecureAuth = insecure,
  allowInsecureHttp = insecure,
}) {
  const oidc = allowInsecureAuth
    ? ""
    : `\n[oidc]\nissuer = "https://issuer.example"\naudience = "rae-platform"\njwksUrl = "https://issuer.example/jwks"\n`;
  const development = allowInsecureAuth || allowInsecureHttp;
  return `[server]\nhost = "${host}"\nport = 8080\n${publicBaseUrl ? `publicBaseUrl = "${publicBaseUrl}"\n` : ""}\n[database]\nurl = "postgres://rae:rae@127.0.0.1:5432/rae_platform"\n[platform]\ndevelopment = ${development}\nallowInsecureAuth = ${allowInsecureAuth}\nallowInsecureHttp = ${allowInsecureHttp}\n${oidc}`;
}

async function readConfig(t, options) {
  const directory = temporaryDirectory(t, "rae-platform-config-");
  const file = join(directory, "platform.toml");
  writeFileSync(file, configDocument(options), { mode: 0o600 });
  return loadConfig(file);
}

test("insecure platform startup is confined to literal loopback bind and public URL", async (t) => {
  assert.equal(isLiteralLoopbackHost("127.0.0.1"), true);
  assert.equal(isLiteralLoopbackHost("[::1]"), true);
  for (const [host, publicBaseUrl] of [
    ["0.0.0.0", "http://127.0.0.1:8080"],
    ["::", "http://[::1]:8080"],
    ["192.168.1.20", "http://127.0.0.1:8080"],
    ["localhost", "http://127.0.0.1:8080"],
    ["127.0.0.1", "http://192.168.1.20:8080"],
    ["127.0.0.1", "http://localhost:8080"],
    ["127.0.0.1", "ftp://127.0.0.1:8080"],
    ["127.0.0.1", "http://user:password@127.0.0.1:8080"],
    ["127.0.0.1", "http://127.0.0.1:8080/control"],
    ["127.0.0.1", "http://127.0.0.1:8080/?debug=1"],
    ["127.0.0.1", undefined],
  ]) {
    await assert.rejects(
      () => readConfig(t, { host, publicBaseUrl, insecure: true }),
      /literal loopback|server\.publicBaseUrl|credential-free HTTP\(S\) origin/,
      `${host} ${publicBaseUrl}`,
    );
  }
  const local = await readConfig(t, {
    host: "127.0.0.1",
    publicBaseUrl: "http://127.0.0.1:8080",
    insecure: true,
  });
  assert.equal(local.oidc, undefined);
});

test("either insecure startup switch rejects non-loopback server binds", async (t) => {
  for (const options of [{ allowInsecureAuth: true }, { allowInsecureHttp: true }]) {
    await assert.rejects(
      () =>
        readConfig(t, {
          host: "0.0.0.0",
          publicBaseUrl: "http://127.0.0.1:8080",
          ...options,
        }),
      /literal loopback server\.host/,
    );
  }
});

test("secure OIDC platform startup preserves public HTTPS deployment configuration", async (t) => {
  const config = await readConfig(t, {
    host: "0.0.0.0",
    publicBaseUrl: "https://platform.example",
  });
  assert.equal(config.oidc.issuer, "https://issuer.example");
});
