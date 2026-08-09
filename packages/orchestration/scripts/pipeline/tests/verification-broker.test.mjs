/** Verifies opaque verification catalogs and the nested no-network policy. */
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  loadVerificationCatalog,
  runVerificationCommand,
  validateVerificationCatalog,
  verificationSandboxProfile,
} from "../lib/verification-broker.mjs";

const roots = [];
function root() {
  const value = realpathSync(mkdtempSync(resolve(tmpdir(), "rae-broker-test-")));
  roots.push(value);
  mkdirSync(resolve(value, "bin"));
  const verify = resolve(value, "bin/verify");
  writeFileSync(verify, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  chmodSync(verify, 0o700);
  return { value, verify, env: { PATH: `${resolve(value, "bin")}${delimiter}/usr/bin:/bin` } };
}

afterEach(() => {
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
});

describe("verification broker", () => {
  test("resolves approved argv vectors to canonical executables", () => {
    const item = root();
    expect(
      validateVerificationCatalog({ focused: ["bin/verify", "--safe"] }, item.value, item.env),
    ).toEqual({
      focused: [item.verify, "--safe"],
    });
    expect(() =>
      validateVerificationCatalog({ Bad: ["bin/verify"] }, item.value, item.env),
    ).toThrow(/invalid verification id/);
    expect(() => validateVerificationCatalog({ focused: [] }, item.value, item.env)).toThrow(
      /argv vector/,
    );
  });

  test("rejects symlinked catalogs and unapproved command ids", () => {
    const item = root();
    const catalog = resolve(item.value, "catalog.json");
    const linked = resolve(item.value, "linked.json");
    writeFileSync(catalog, JSON.stringify({ focused: ["bin/verify"] }), { mode: 0o600 });
    symlinkSync(catalog, linked);
    expect(() => loadVerificationCatalog(linked, item.value, item.env)).toThrow(/non-symlink/);
    const loaded = loadVerificationCatalog(catalog, item.value, item.env);
    expect(() =>
      runVerificationCommand({ id: "unknown", catalog: loaded, workspaceRoot: item.value }),
    ).toThrow(/not approved/);
  });

  test("verification commands fail closed off macOS and deny network in policy", () => {
    const item = root();
    const catalog = validateVerificationCatalog({ focused: ["bin/verify"] }, item.value, item.env);
    expect(() =>
      runVerificationCommand({
        id: "focused",
        catalog,
        workspaceRoot: item.value,
        platform: "linux",
      }),
    ).toThrow(/macOS sandbox backend/);
    const policy = verificationSandboxProfile(item.value, item.verify);
    expect(policy).toContain("(deny default)");
    expect(policy).toContain("(deny network*)");
    expect(policy).toContain(`${item.value}/.git`);
    expect(policy).toContain(`${item.value}/.pipeline`);
  });

  const containmentTest =
    process.platform === "darwin" && existsSync("/Library/Developer/CommandLineTools/usr/bin/git")
      ? test
      : test.skip;
  containmentTest("executes the approved Git verifier under real no-network Seatbelt", () => {
    const item = root();
    const git = "/Library/Developer/CommandLineTools/usr/bin/git";
    const initialized = spawnSync(git, ["init", "-q", item.value]);
    expect(initialized.status).toBe(0);
    const catalog = validateVerificationCatalog(
      { "git-diff-check": [git, "diff", "--check"] },
      item.value,
      item.env,
    );
    expect(
      runVerificationCommand({
        id: "git-diff-check",
        catalog,
        workspaceRoot: item.value,
      }),
    ).toMatchObject({ successful: true, exit_code: 0, termination_signal: null });
  });
});
