/** Purpose: stateless, scope-protected Streamable HTTP MCP run controls. */
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { requireProject, requireScope } from "./auth.mjs";
const runInput = { run_id: z.string().uuid() };
const idempotencyKey = z.string().regex(/^[\x21-\x7e]{1,200}$/);
const runEnvelope = z
  .object({
    revision: z.object({
      digest: z.string().length(64),
      definition: z.record(z.string(), z.unknown()),
    }),
    nodes: z.array(
      z.object({
        key: z.string(),
        payload: z.record(z.string(), z.unknown()).optional(),
        access: z.enum(["read", "write"]).default("read"),
      }),
    ),
    request: z.record(z.string(), z.unknown()).default({}),
    repositoryDigest: z.string().length(64).optional(),
    worktreeDigest: z.string().length(64).optional(),
  })
  .strict();
export async function handleStreamableMcp({ request, response, body, store, principal }) {
  const server = new McpServer({
    name: "rae-experimental-platform",
    version: "0.1.0-experimental",
  });
  const run = async (runId) => {
    const value = await store.getRun(runId);
    if (!value) throw Object.assign(new Error("run not found"), { statusCode: 404 });
    requireProject(principal, value.projectId);
    return value;
  };
  server.registerTool(
    "rae_submit_run",
    {
      description: "Submit a project-authorized run",
      inputSchema: {
        project_id: z.string(),
        envelope: runEnvelope,
        idempotency_key: idempotencyKey,
      },
    },
    async ({ project_id, envelope, idempotency_key }) => {
      requireScope(principal, "rae.run.submit");
      requireProject(principal, project_id);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              await store.createRun({
                ...envelope,
                projectId: project_id,
                idempotencyKey: idempotency_key,
              }),
            ),
          },
        ],
      };
    },
  );
  server.registerTool(
    "rae_get_run",
    { description: "Read a permitted RAE run", inputSchema: runInput },
    async ({ run_id }) => {
      requireScope(principal, "rae.run.read");
      return { content: [{ type: "text", text: JSON.stringify(await run(run_id)) }] };
    },
  );
  server.registerTool(
    "rae_list_events",
    { description: "Read immutable events", inputSchema: runInput },
    async ({ run_id }) => {
      requireScope(principal, "rae.run.read");
      await run(run_id);
      return {
        content: [{ type: "text", text: JSON.stringify(await store.listRunEvents(run_id)) }],
      };
    },
  );
  server.registerTool(
    "rae_signal_run",
    {
      description: "Append an operator signal",
      inputSchema: {
        ...runInput,
        kind: z.string().regex(/^[A-Za-z0-9._-]{1,128}$/),
        payload: z.record(z.string(), z.unknown()),
        idempotency_key: idempotencyKey,
      },
    },
    async ({ run_id, kind, payload, idempotency_key }) => {
      requireScope(principal, "rae.run.signal");
      await run(run_id);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              await store.signalRun({
                runId: run_id,
                kind,
                payload,
                idempotencyKey: idempotency_key,
              }),
            ),
          },
        ],
      };
    },
  );
  server.registerTool(
    "rae_cancel_run",
    {
      description: "Cancel a permitted run",
      inputSchema: { ...runInput, idempotency_key: idempotencyKey },
    },
    async ({ run_id, idempotency_key }) => {
      requireScope(principal, "rae.run.cancel");
      await run(run_id);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              await store.cancelRun({ runId: run_id, idempotencyKey: idempotency_key }),
            ),
          },
        ],
      };
    },
  );
  server.registerResource(
    "rae-run",
    new ResourceTemplate("rae://runs/{run_id}", { list: undefined }),
    { mimeType: "application/json" },
    async (uri, { run_id }) => {
      requireScope(principal, "rae.run.read");
      return {
        contents: [
          { uri: uri.href, mimeType: "application/json", text: JSON.stringify(await run(run_id)) },
        ],
      };
    },
  );
  server.registerResource(
    "rae-events",
    new ResourceTemplate("rae://runs/{run_id}/events", { list: undefined }),
    { mimeType: "application/json" },
    async (uri, { run_id }) => {
      requireScope(principal, "rae.run.read");
      await run(run_id);
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(await store.listRunEvents(run_id)),
          },
        ],
      };
    },
  );
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(request, response, body);
  } finally {
    await transport.close();
    await server.close();
  }
}
