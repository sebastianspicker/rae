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
import test, { type TestContext } from "node:test";
import { isLiteralLoopbackHost, loadConfig } from "../src/config.js";
import { prepareHostedAttempt } from "../src/attempt-runtime.js";

function temporaryDirectory(t: TestContext, prefix: string) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function makeRuntimePath(root: string, through: string, createTarget = false) {
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

interface ConfigOptions {
  host: string;
  publicBaseUrl?: string;
  insecure?: boolean;
  allowInsecureAuth?: boolean;
  allowInsecureHttp?: boolean;
}
function configDocument({
  host,
  publicBaseUrl,
  insecure = false,
  allowInsecureAuth = insecure,
  allowInsecureHttp = insecure,
}: ConfigOptions) {
  const oidc = allowInsecureAuth
    ? ""
    : `\n[oidc]\nissuer = "https://issuer.example"\naudience = "rae-platform"\njwksUrl = "https://issuer.example/jwks"\n`;
  const development = allowInsecureAuth || allowInsecureHttp;
  return `[server]\nhost = "${host}"\nport = 8080\n${publicBaseUrl ? `publicBaseUrl = "${publicBaseUrl}"\n` : ""}\n[database]\nurl = "postgres://rae:rae@127.0.0.1:5432/rae_platform"\n[platform]\ndevelopment = ${development}\nallowInsecureAuth = ${allowInsecureAuth}\nallowInsecureHttp = ${allowInsecureHttp}\n${oidc}`;
}

async function readConfig(t: TestContext, options: ConfigOptions) {
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
  ] as const) {
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
  assert.equal(config.oidc?.issuer, "https://issuer.example");
});

test("hosted bootstrap parent swaps cannot redirect schema writes outside the anchored directory", (t) => {
  const directory = temporaryDirectory(t, "rae-hosted-swap-");
  const root = resolve(join(directory, "project"));
  const outside = resolve(join(directory, "outside"));
  mkdirSync(root, { mode: 0o700 });
  mkdirSync(outside, { mode: 0o700 });
  const original = filesystem.writeFileSync;
  let intercepted = false;
  t.mock.method(
    filesystem,
    "writeFileSync",
    (...args: Parameters<typeof filesystem.writeFileSync>) => {
      if (typeof args[0] === "number" && !intercepted) {
        intercepted = true;
        filesystem.renameSync(join(root, ".pipeline"), join(root, "detached-pipeline"));
        symlinkSync(outside, join(root, ".pipeline"));
      }
      return original(...args);
    },
  );
  assert.throws(
    () => prepareHostedAttempt(root, "run", "attempt", { type: "object" }),
    /changed|non-symlink/,
  );
  assert.equal(intercepted, true);
  assert.deepEqual(filesystem.readdirSync(outside), []);
  assert.equal(
    filesystem.readFileSync(
      join(root, "detached-pipeline", "hosted-worker", "run", "attempt", "output.schema.json"),
      "utf8",
    ),
    '{"type":"object"}\n',
  );
});

import filesystem from "node:fs";

test("hosted schema assertions reject in-place edits and artifact publication is no-clobber", (t) => {
  const root = temporaryDirectory(t, "rae-hosted-digest-");
  const runtime = prepareHostedAttempt(root, "run", "attempt", { type: "object" });
  runtime.publishArtifact("output.json", Buffer.from("{}\n"));
  assert.throws(() => runtime.publishArtifact("output.json", Buffer.from("changed")));
  filesystem.writeFileSync(runtime.schemaPath, '{"type":"string"}\n');
  assert.throws(runtime.assertIntact, /content changed/);
  assert.throws(
    () => runtime.publishArtifact("events.jsonl", Buffer.from("{}\n")),
    /content changed/,
  );
  assert.equal(filesystem.existsSync(join(runtime.attemptRoot, "events.jsonl")), false);
});

test("interrupted artifact publication leaves no partial final name and can be retried", (t) => {
  const root = temporaryDirectory(t, "rae-hosted-publish-");
  const runtime = prepareHostedAttempt(root, "run", "attempt", { type: "object" });
  const original = filesystem.writeFileSync;
  const fault = t.mock.method(
    filesystem,
    "writeFileSync",
    (...args: Parameters<typeof filesystem.writeFileSync>) => {
      if (typeof args[0] === "number") {
        filesystem.writeSync(args[0], Buffer.from("partial"));
        throw new Error("injected write failure");
      }
      return original(...args);
    },
  );
  assert.throws(() => runtime.publishArtifact("output.json", Buffer.from("{}\n")), /injected/);
  assert.deepEqual(filesystem.readdirSync(runtime.attemptRoot), ["output.schema.json"]);
  fault.mock.restore();
  runtime.publishArtifact("output.json", Buffer.from("{}\n"));
  assert.equal(filesystem.readFileSync(join(runtime.attemptRoot, "output.json"), "utf8"), "{}\n");
});
