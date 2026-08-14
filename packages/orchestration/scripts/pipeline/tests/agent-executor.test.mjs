/**
 * Exercises provider selection, redaction, and structured agent artifacts so pipeline phases fail safely.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { agentDoctor, minimalChildEnvironment, runAgentPhase } from "../lib/agent-executor.mjs";
import { codexCapabilityArgs } from "../lib/codex-capabilities.mjs";
import {
  cleanupTempRoots,
  fakeCodex,
  fakeCodexProfileSurface,
  fakeCodexRuntime,
  profileCapabilities,
  tempRoots,
} from "./agent-executor-test-fixtures.mjs";

afterEach(() => {
  cleanupTempRoots();
});

describe("agentDoctor", () => {
  it("builds a sealed one-run capability surface and hides MCP credentials from shell tools", () => {
    const args = codexCapabilityArgs({
      web_search: "disabled",
      credential_env_vars: ["RESEARCH_MCP_TOKEN"],
      mcp_servers: [
        {
          name: "research",
          url: "https://mcp.example.invalid/rae",
          enabled_tools: ["lookup_claim"],
          token_env_var: "RESEARCH_MCP_TOKEN",
        },
      ],
    });
    expect(args).toContain("--ignore-user-config");
    expect(args).toContain("--ignore-rules");
    expect(args).toContain("--strict-config");
    expect(args).toContain('web_search="disabled"');
    expect(args).toContain("features.apps=false");
    expect(args).toContain("features.plugins=false");
    expect(args).toContain('mcp_servers.research.enabled_tools=["lookup_claim"]');
    expect(args).toContain('shell_environment_policy.filters.RESEARCH_MCP_TOKEN="exclude"');
  });

  it("drops ambient proxy, trust-store, XDG, and undeclared credential variables for v2", () => {
    const child = minimalChildEnvironment(
      {
        PATH: "/bin",
        HOME: "/home/fixture",
        CODEX_HOME: "/codex/fixture",
        HTTPS_PROXY: "http://proxy.invalid",
        SSL_CERT_FILE: "/private/ca.pem",
        XDG_CONFIG_HOME: "/private/config",
        OPENAI_API_KEY: "ambient-provider-secret",
        RAE_MCP_TOKEN_RESEARCH: "declared-mcp-secret",
      },
      "/workspace",
      ["RAE_MCP_TOKEN_RESEARCH"],
    );
    expect(child).toMatchObject({
      PATH: "/bin",
      HOME: "/home/fixture",
      CODEX_HOME: "/codex/fixture",
      RAE_MCP_TOKEN_RESEARCH: "declared-mcp-secret",
      PWD: "/workspace",
    });
    expect(child.HTTPS_PROXY).toBeUndefined();
    expect(child.SSL_CERT_FILE).toBeUndefined();
    expect(child.XDG_CONFIG_HOME).toBeUndefined();
    expect(child.OPENAI_API_KEY).toBeUndefined();
  });

  it("runs Codex with only the profile-declared MCP surface and credential", () => {
    const { root } = fakeCodexRuntime();
    const result = runAgentPhase({
      provider: "codex",
      workspaceRoot: root,
      schemaPath: join(root, "schema.json"),
      outputPath: join(root, "artifact.json"),
      eventLogPath: join(root, "events.jsonl"),
      prompt: "CAPABILITY_PROBE",
      sandboxMode: "read-only",
      timeoutMs: 5_000,
      capabilities: {
        web_search: "disabled",
        credential_env_vars: ["RAE_MCP_TOKEN_RESEARCH"],
        mcp_servers: [
          {
            name: "research",
            url: "https://mcp.example.invalid/rae",
            enabled_tools: ["lookup_claim"],
            token_env_var: "RAE_MCP_TOKEN_RESEARCH",
          },
        ],
      },
      env: {
        PATH: root,
        HOME: root,
        CODEX_HOME: root,
        HTTPS_PROXY: "http://ambient-proxy.invalid",
        RAE_MCP_TOKEN_RESEARCH: "declared-token",
        UNDECLARED_SECRET: "must-not-leak",
      },
    });

    expect(result.capabilitySurface.mcp_servers[0].enabled_tools).toEqual(["lookup_claim"]);
    expect(result.credentialManifest).toEqual([
      {
        name: "RAE_MCP_TOKEN_RESEARCH",
        digest: "85e04780d862d1d9814a9a1575e689dab694f01f25f9e5d9510e3ee60f836970",
      },
    ]);
  });

  it("passes only when Codex has required capabilities and authentication", () => {
    const path = fakeCodex(true);
    const result = agentDoctor({ provider: "codex", env: { PATH: path } });

    expect(result.success).toBe(true);
    expect(result.sandbox_enforced).toBe(true);
    expect(result.capabilities.authenticated).toBe(true);
    expect(result.capabilities.profile_surface).toBeUndefined();
    expect(result.effective_surface).toBeNull();
  });

  it("fails when the Codex CLI is not authenticated", () => {
    const path = fakeCodex(false);
    const result = agentDoctor({ provider: "codex", env: { PATH: path } });

    expect(result.success).toBe(false);
    expect(result.capabilities.authenticated).toBe(false);
    expect(result.detail).toContain("unauthenticated");
  });

  it("skips non-executable PATH entries and fails closed when no executable remains", () => {
    const blockedRoot = mkdtempSync(join(tmpdir(), "rae-non-executable-codex-"));
    tempRoots.push(blockedRoot);
    const blockedExecutable = join(blockedRoot, "codex");
    writeFileSync(blockedExecutable, "#!/bin/sh\nexit 0\n", "utf8");
    chmodSync(blockedExecutable, 0o644);
    const executableRoot = fakeCodex(true);

    expect(
      agentDoctor({
        provider: "codex",
        env: { PATH: [blockedRoot, executableRoot].join(delimiter) },
      }).success,
    ).toBe(true);
    expect(agentDoctor({ provider: "codex", env: { PATH: blockedRoot } })).toMatchObject({
      success: false,
      executable: null,
    });
  });

  it("proves the exact sealed Codex profile surface and cleans its temporary home", () => {
    const expected = profileCapabilities();
    const { root, transcriptPath, sequencePath } = fakeCodexProfileSurface({
      output: JSON.stringify([
        {
          name: "research",
          url: "https://mcp.example.invalid/rae",
          enabled_tools: ["zeta", "alpha"],
        },
        {
          name: "archive",
          url: "https://mcp.example.invalid/archive",
          enabled_tools: ["read"],
        },
      ]),
    });
    const result = agentDoctor({
      provider: "codex",
      workspaceRoot: root,
      capabilities: expected,
      env: {
        PATH: root,
        HOME: root,
        CODEX_HOME: root,
        RAE_MCP_TOKEN_RESEARCH: "declared-token",
        HTTPS_PROXY: "http://ambient-proxy.invalid",
        SSL_CERT_FILE: "/private/ca.pem",
        XDG_CONFIG_HOME: "/private/config",
        UNDECLARED_SECRET: "ambient-secret",
      },
    });

    expect(result.success).toBe(true);
    expect(result.effective_surface).toEqual({
      ...expected,
      credential_env_vars: ["RAE_MCP_TOKEN_RESEARCH"],
      disabled_surfaces: ["apps", "hooks", "plugins", "project-rules", "web-search"],
      mcp_servers: [
        {
          name: "archive",
          url: "https://mcp.example.invalid/archive",
          enabled_tools: ["read"],
          token_env_var: "RAE_MCP_TOKEN_RESEARCH",
        },
        {
          name: "research",
          url: "https://mcp.example.invalid/rae",
          enabled_tools: ["alpha", "zeta"],
          token_env_var: "RAE_MCP_TOKEN_RESEARCH",
        },
      ],
    });
    const transcript = JSON.parse(readFileSync(transcriptPath, "utf8"));
    const sequence = readFileSync(sequencePath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(sequence[0]).toEqual(["exec", "--help"]);
    expect(sequence[1]).toEqual(["login", "status"]);
    expect(sequence[2]).toContain("mcp");
    expect(transcript.args).toContain('mcp_servers.research.enabled_tools=["alpha","zeta"]');
    expect(transcript.args).toContain('mcp_servers.archive.enabled_tools=["read"]');
    expect(transcript.env.RAE_MCP_TOKEN_RESEARCH).toBe("declared-token");
    expect(transcript.env).not.toHaveProperty("HTTPS_PROXY");
    expect(transcript.env).not.toHaveProperty("SSL_CERT_FILE");
    expect(transcript.env).not.toHaveProperty("XDG_CONFIG_HOME");
    expect(transcript.env).not.toHaveProperty("UNDECLARED_SECRET");
    expect(transcript.cwd).not.toBe(root);
    expect(transcript.env.CODEX_HOME).not.toBe(root);
    expect(existsSync(transcript.cwd)).toBe(false);
    expect(existsSync(transcript.env.CODEX_HOME)).toBe(false);
  });

  it("fails closed for invalid effective Codex profile surfaces", () => {
    const expected = profileCapabilities();
    const matchingSurfaces = [
      {
        name: "archive",
        url: "https://mcp.example.invalid/archive",
        enabled_tools: ["read"],
      },
      {
        name: "research",
        url: "https://mcp.example.invalid/rae",
        enabled_tools: ["alpha", "zeta"],
      },
    ];
    const cases = [
      { name: "missing", output: "[]" },
      {
        name: "extra",
        output: JSON.stringify([
          ...matchingSurfaces,
          { name: "extra", url: "https://mcp.example.invalid/extra", enabled_tools: [] },
        ]),
      },
      {
        name: "url mutation",
        output: JSON.stringify([
          matchingSurfaces[0],
          { ...matchingSurfaces[1], url: "https://mcp.example.invalid/changed" },
        ]),
      },
      {
        name: "tool mutation",
        output: JSON.stringify([
          matchingSurfaces[0],
          { ...matchingSurfaces[1], enabled_tools: ["alpha"] },
        ]),
      },
      {
        name: "server mutation",
        output: JSON.stringify([matchingSurfaces[1], { ...matchingSurfaces[0], name: "changed" }]),
      },
      { name: "malformed", output: "not-json" },
      { name: "nonzero", output: "[]", status: 1, stderr: "token=profile-secret" },
    ];

    for (const fixture of cases) {
      const { root, transcriptPath } = fakeCodexProfileSurface(fixture);
      const result = agentDoctor({
        provider: "codex",
        workspaceRoot: root,
        capabilities: expected,
        env: { PATH: root, RAE_MCP_TOKEN_RESEARCH: "declared-token" },
      });
      expect(result.success, fixture.name).toBe(false);
      expect(result.effective_surface, fixture.name).toBeNull();
      expect(result.capabilities.profile_surface, fixture.name).toBe(false);
      expect(result.capabilities.profile_surface_error, fixture.name).toBeTruthy();
      expect(result.capabilities.profile_surface_error, fixture.name).not.toContain(
        "profile-secret",
      );
      const transcript = JSON.parse(readFileSync(transcriptPath, "utf8"));
      expect(existsSync(transcript.cwd), fixture.name).toBe(false);
    }
  });

  it("does not run later Codex probes for unavailable or command providers", () => {
    const { root, sequencePath } = fakeCodexProfileSurface();
    const unavailable = agentDoctor({ provider: "codex", env: { PATH: join(root, "missing") } });
    const command = agentDoctor({ provider: "command", command: "codex", env: { PATH: root } });

    expect(unavailable).toEqual({
      success: false,
      provider: "codex",
      executable: null,
      sandbox_enforced: false,
      detail: "Codex CLI is not available on PATH",
    });
    expect(command).toMatchObject({
      success: false,
      provider: "command",
      executable: join(root, "codex"),
      sandbox_enforced: false,
      available: true,
    });
    expect(existsSync(sequencePath)).toBe(false);
  });

  it("rejects project-owned capabilities before probing the profile surface", () => {
    const { root, transcriptPath } = fakeCodexProfileSurface();
    const forbiddenRoot = join(root, ".codex", "skills");
    mkdirSync(forbiddenRoot, { recursive: true });
    writeFileSync(join(forbiddenRoot, "project.md"), "not allowed", "utf8");

    const result = agentDoctor({
      provider: "codex",
      workspaceRoot: root,
      capabilities: profileCapabilities(),
      env: { PATH: root, RAE_MCP_TOKEN_RESEARCH: "declared-token" },
    });

    expect(result.success).toBe(false);
    expect(result.capabilities.profile_surface).toBe(false);
    expect(existsSync(transcriptPath)).toBe(false);
  });
});
