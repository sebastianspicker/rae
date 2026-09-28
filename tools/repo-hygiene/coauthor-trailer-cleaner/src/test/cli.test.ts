/** Disposable CLI characterization preserves configuration precedence, validation and mutation modes. */
import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test, { type TestContext } from "node:test";
import { git } from "../git.js";
const url = "https://github.com/fixture/project";
function fixture(t: TestContext) {
  const root = fs.mkdtempSync(join(tmpdir(), "rae-history-cli-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repository = join(root, "repo with $ literal");
  fs.mkdirSync(repository);
  git(repository, ["init", "-b", "main"]);
  git(repository, ["config", "user.name", "Fixture"]);
  git(repository, ["config", "user.email", "fixture@example.test"]);
  git(repository, ["config", "commit.gpgsign", "false"]);
  fs.writeFileSync(join(repository, "source.txt"), "preserve tree\n");
  git(repository, ["add", "."]);
  git(repository, [
    "commit",
    "-m",
    "Fixture\n\nCo-authored-by: Pair Bot <pair@example.test>\nCo-authored-by: Other Bot <other@example.test>\n",
  ]);
  const before = git(repository, ["show-ref"]).toString();
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [new URL("../cli.js", import.meta.url).pathname, ...args], {
      encoding: "utf8",
      timeout: 15_000,
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
    });
  return { root, repository, before, run };
}
test("config repositories override other sources and null optional values retain defaults", (t) => {
  const f = fixture(t);
  const config = join(f.root, "config.json");
  fs.writeFileSync(
    config,
    JSON.stringify({
      defaults: { backupRemote: null },
      targets: null,
      repos: [{ url, path: f.repository }],
    }),
  );
  const result = f.run(
    "--config",
    config,
    "--validate-only",
    "--repos-file",
    join(f.root, "missing"),
    "ignored-positional",
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(git(f.repository, ["show-ref"]).toString(), f.before);
});
test("CLI targets override config targets and rewrite only the disposable repository", (t) => {
  const f = fixture(t);
  const config = join(f.root, "config.json");
  fs.writeFileSync(
    config,
    JSON.stringify({
      targets: [{ name: "Other Bot", email: "other@example.test" }],
      repos: [{ url, path: f.repository }],
    }),
  );
  const tree = git(f.repository, ["rev-parse", "HEAD^{tree}"]).toString();
  const result = f.run("--config", config, "--target", "Pair Bot <pair@example.test>", "--no-push");
  assert.equal(result.status, 0, result.stderr);
  const message = git(f.repository, ["log", "-1", "--format=%B"]).toString();
  assert.doesNotMatch(message, /Co-authored-by: Pair Bot/);
  assert.match(message, /Co-authored-by: Other Bot/);
  assert.equal(git(f.repository, ["rev-parse", "HEAD^{tree}"]).toString(), tree);
});
test("repository files preserve space-containing paths and dry-run leaves dirty files and refs intact", (t) => {
  const f = fixture(t);
  const list = join(f.root, "repos.txt");
  fs.writeFileSync(list, `# fixture\ninvalid-line\n${url} ${f.repository}\n`);
  fs.writeFileSync(join(f.repository, "source.txt"), "uncommitted user bytes\n");
  const result = f.run("--repos-file", list, "--dry-run");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /Repos file line/);
  assert.equal(git(f.repository, ["show-ref"]).toString(), f.before);
  assert.equal(
    fs.readFileSync(join(f.repository, "source.txt"), "utf8"),
    "uncommitted user bytes\n",
  );
});
test("malformed defaults, unknown config keys and invalid identities fail before mutation", (t) => {
  const f = fixture(t);
  const config = join(f.root, "config.json");
  for (const value of [
    { defaults: null },
    { defaults: { dryRun: "false" } },
    { unexpected: true },
    { targets: [{ name: "x", email: "bad" }] },
  ]) {
    fs.writeFileSync(config, JSON.stringify(value));
    const result = f.run("--config", config, url, f.repository);
    assert.equal(result.status, 1);
    assert.equal(git(f.repository, ["show-ref"]).toString(), f.before);
  }
});

test("invalid UTF-8 and JSON BOM config files fail before mutation", (t) => {
  const f = fixture(t);
  const config = join(f.root, "config.json");
  for (const bytes of [Buffer.from([0xff]), Buffer.from("\ufeff{}")]) {
    fs.writeFileSync(config, bytes);
    const result = f.run("--config", config, url, f.repository);
    assert.equal(result.status, 1);
    assert.equal(git(f.repository, ["show-ref"]).toString(), f.before);
  }
});
