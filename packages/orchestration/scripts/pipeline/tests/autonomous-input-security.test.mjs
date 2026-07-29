/** Verifies task-file confinement, fresh unsafe opt-in, and child environment scrubbing. */
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { minimalChildEnvironment } from "../lib/agent-executor.mjs";
import { buildPrompt } from "../lib/autonomous-phase-contract.mjs";
import {
  mergeResumeOptions,
  safeTaskFile,
  savedAgentOptions,
} from "../lib/autonomous-lifecycle.mjs";

const roots = [];

function taskRoot() {
  const root = mkdtempSync(join(tmpdir(), "rae-task-file-"));
  roots.push(root);
  mkdirSync(join(root, "tasks"));
  writeFileSync(join(root, "tasks", "work.md"), "Implement the checked behavior.\n");
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("autonomous input security", () => {
  it("accepts a regular project-relative Markdown task", () => {
    const root = taskRoot();
    expect(safeTaskFile("tasks/work.md", root)).toBe("Implement the checked behavior.");
  });

  it.each([
    ["absolute", (root) => resolve(root, "tasks/work.md")],
    ["traversal", () => "../outside.md"],
    ["protected directory", () => ".ssh/work.md"],
    ["wrong extension", () => "tasks/work.json"],
  ])("rejects an %s task path", (_label, taskPath) => {
    const root = taskRoot();
    expect(() => safeTaskFile(taskPath(root), root)).toThrow();
  });

  it("rejects symlinks, invalid UTF-8, and empty task files", () => {
    const root = taskRoot();
    symlinkSync("work.md", join(root, "tasks", "link.md"));
    writeFileSync(join(root, "tasks", "invalid.txt"), Buffer.from([0xc3, 0x28]));
    writeFileSync(join(root, "tasks", "empty.txt"), "  \n");
    expect(() => safeTaskFile("tasks/link.md", root)).toThrow(/non-symlink/);
    expect(() => safeTaskFile("tasks/invalid.txt", root)).toThrow(/valid UTF-8/);
    expect(() => safeTaskFile("tasks/empty.txt", root)).toThrow(/must not be empty/);
  });

  it("rejects oversized and non-regular task entries", () => {
    const root = taskRoot();
    writeFileSync(join(root, "tasks", "large.txt"), Buffer.alloc(129 * 1024, 0x61));
    mkdirSync(join(root, "tasks", "directory.md"));
    expect(() => safeTaskFile("tasks/large.txt", root)).toThrow(/exceeds 131072 bytes/);
    expect(() => safeTaskFile("tasks/directory.md", root)).toThrow(/regular, non-symlink/);
  });

  it("rejects a task path swapped after its descriptor is opened", () => {
    const root = taskRoot();
    const task = join(root, "tasks", "work.md");
    expect(() =>
      safeTaskFile("tasks/work.md", root, {
        afterOpen() {
          renameSync(task, join(root, "tasks", "original.md"));
          writeFileSync(task, "Replacement task must not be accepted.\n");
        },
      }),
    ).toThrow(/changed while it was being read/);
  });

  it("bounds and rejects a task file that grows after its descriptor is opened", () => {
    const root = taskRoot();
    const task = join(root, "tasks", "work.md");
    expect(() =>
      safeTaskFile("tasks/work.md", root, {
        afterOpen() {
          appendFileSync(task, Buffer.alloc(129 * 1024, 0x61));
        },
      }),
    ).toThrow(/exceeds 131072 bytes/);
  });

  it("removes the absolute workspace root from every predecessor prompt field", () => {
    const root = taskRoot();
    const prompt = buildPrompt({
      phase: "design",
      task: `Design the requested change in ${root}`,
      runId: "prompt-run",
      workspaceRoot: root,
      inputs: {
        context_manifest: {
          code_files: [join(root, "tasks", "work.md")],
          command: `node --cwd ${root} verify.mjs`,
          [root]: "absolute keys are sanitized too",
        },
        external_path: "/outside/private/artifact.json",
      },
      policy: { phase_guidance: { design: `Inspect ${root}/tasks first.` } },
    });

    expect(prompt).not.toContain(root);
    expect(prompt).toContain("tasks/work.md");
    expect(prompt).toContain("node --cwd . verify.mjs");
    expect(prompt).toContain("<absolute-path-omitted>");
    expect(prompt).toContain("Workspace: current working directory");
  });

  it("sanitizes embedded POSIX, Windows, UNC, and file URL path tokens", () => {
    const root = taskRoot();
    const localFileUrl = `${pathToFileURL(join(root, "tasks", "work.md")).href}#L12`;
    const prompt = buildPrompt({
      phase: "design",
      task: "Preserve the surrounding semantic text",
      runId: "embedded-path-run",
      workspaceRoot: root,
      inputs: {
        note:
          `alpha posix=/private/secret/report.txt. ` +
          `windows=C:\\Users\\Alice\\secret.txt ` +
          `unc=\\\\server\\share\\secret.txt ` +
          `local=${join(root, "tasks", "work.md")} ` +
          `file_url=${localFileUrl} ` +
          "web=https://example.test/public/path omega",
      },
      policy: null,
    });

    expect(prompt).toContain(
      "alpha posix=<absolute-path-omitted>. windows=<absolute-path-omitted> " +
        "unc=<absolute-path-omitted> local=tasks/work.md " +
        "file_url=tasks/work.md#L12 web=https://example.test/public/path omega",
    );
    expect(prompt).not.toContain("/private/secret");
    expect(prompt).not.toContain("C:\\\\Users");
    expect(prompt).not.toContain("server\\\\share");
  });

  it("sanitizes spaced paths, forward UNC, angle boundaries, and file URL values", () => {
    const root = taskRoot();
    const fileUrl = pathToFileURL(join(root, "tasks", "work.md")).href;
    const prompt = buildPrompt({
      phase: "design",
      task: "Preserve privacy around complex path forms",
      runId: "complex-path-run",
      workspaceRoot: root,
      inputs: {
        note:
          `alpha posix="/private/Secret Folder/report.txt" ` +
          `windows='C:\\Users\\Alice\\Secret Folder\\report.txt' ` +
          `unc="\\\\server\\share\\Secret Folder\\report.txt" ` +
          `forward_unc=//server/share/SecretFolder/report.txt ` +
          `local="${join(root, "tasks", "My File.md")}" ` +
          `boundary=>/private/BoundarySecret/report.txt ` +
          `file=<${fileUrl}?next=%2Fprivate%2FQuery%20Secret%2Freport.txt` +
          `#target=C%3A%5CUsers%5CAlice%5CFragment%20Secret%5Creport.txt> ` +
          "web=https://example.test/public/path omega",
      },
      policy: null,
    });

    expect(prompt).toContain('local=\\"tasks/My File.md\\"');
    expect(prompt).toContain("boundary=><absolute-path-omitted>");
    expect(prompt).toContain("web=https://example.test/public/path omega");
    for (const secret of [
      "/private/Secret Folder",
      "C:\\\\Users\\\\Alice\\\\Secret Folder",
      "server\\\\share\\\\Secret Folder",
      "//server/share/SecretFolder",
      "/private/BoundarySecret",
      "Query%20Secret",
      "Fragment%20Secret",
    ]) {
      expect(prompt).not.toContain(secret);
    }
  });

  it("never restores poisoned command-provider authorization from saved state", () => {
    const saved = savedAgentOptions({
      provider: "command",
      checkpoint_policy: "none",
      agent: {
        provider: "command",
        command: "/poison/provider",
        command_args: ["poison.mjs"],
        allow_unsafe_command_provider: true,
      },
    });
    const ordinary = mergeResumeOptions(saved, { _: [], agentArgs: [] });
    expect(ordinary).toMatchObject({ provider: "auto", agentArgs: [] });
    expect(ordinary["agent-command"]).toBeUndefined();
    expect(ordinary["allow-unsafe-command-provider"]).toBeUndefined();

    const explicit = mergeResumeOptions(saved, {
      provider: "command",
      "agent-command": "/test/provider",
      agentArgs: ["fixture.mjs"],
      "allow-unsafe-command-provider": true,
    });
    expect(explicit).toMatchObject({
      provider: "command",
      "agent-command": "/test/provider",
      agentArgs: ["fixture.mjs"],
      "allow-unsafe-command-provider": true,
    });
  });

  it("keeps required runtime variables and removes unknown secrets", () => {
    const env = minimalChildEnvironment(
      {
        PATH: "/bin",
        HOME: "/home/test",
        OPENAI_API_KEY: "required-auth",
        HTTPS_PROXY: "https://proxy.invalid",
        SSL_CERT_FILE: "/cert.pem",
        LANG: "C.UTF-8",
        TMPDIR: "/tmp",
        AWS_SESSION_TOKEN: "must-not-leak",
        UNKNOWN_SECRET: "must-not-leak",
        CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "untrusted",
      },
      "/workspace",
    );
    expect(env).toMatchObject({
      PATH: "/bin",
      HOME: "/home/test",
      OPENAI_API_KEY: "required-auth",
      HTTPS_PROXY: "https://proxy.invalid",
      SSL_CERT_FILE: "/cert.pem",
      LANG: "C.UTF-8",
      TMPDIR: "/tmp",
      PWD: "/workspace",
      CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "codex_cli_rs",
    });
    expect(env.AWS_SESSION_TOKEN).toBeUndefined();
    expect(env.UNKNOWN_SECRET).toBeUndefined();
  });
});
