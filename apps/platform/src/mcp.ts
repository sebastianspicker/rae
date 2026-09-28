/** Purpose: stateless, scope-protected Streamable HTTP MCP run controls. */
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { requireProject, requireScope } from "./auth.js";
const runInput = { run_id: z.string().uuid() };
const idempotencyKey = z.string().regex(/^[\x21-\x7e]{1,200}$/);
const runEnvelope = z
  .object({
    revision: z.object({
      digest: z.string().length(64),
      definition: z.record(z.string(), z.unknown()),
    }),
    nodes: z
      .array(
        z.object({
          key: z.string(),
          payload: z.record(z.string(), z.unknown()).optional(),
          access: z.enum(["read", "write"]).default("read"),
        }),
      )
      .max(MAX_RUN_NODES),
    request: z.record(z.string(), z.unknown()).default({}),
    repositoryDigest: z.string().length(64).optional(),
    worktreeDigest: z.string().length(64).optional(),
  })
  .strict();
export async function handleStreamableMcp({
  request,
  response,
  body,
  store,
  principal,
}: {
  request: IncomingMessage;
  response: ServerResponse;
  body: unknown;
  store: MemoryStore | PostgresStore;
  principal: Principal;
}) {
  const server = new McpServer({
    name: "rae-experimental-platform",
    version: "0.1.0-experimental",
  });
  const run = async (runId: string) => {
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
      return { content: [{ type: "text", text: JSON.stringify(await run(uuidVariable(run_id))) }] };
    },
  );
  server.registerTool(
    "rae_list_events",
    {
      description: "Read a bounded page of immutable events",
      inputSchema: {
        ...runInput,
        cursor: z.string().optional(),
        limit: z.number().int().min(1).max(1000).optional(),
      },
    },
    async ({ run_id, cursor, limit }) => {
      requireScope(principal, "rae.run.read");
      await run(uuidVariable(run_id));
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              await store.listRunEvents(run_id, {
                cursor,
                limit,
                encoding: pageEncoding(body, (page) => ({
                  content: [{ type: "text", text: JSON.stringify(page) }],
                })),
              }),
            ),
          },
        ],
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
      await run(uuidVariable(run_id));
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
      await run(uuidVariable(run_id));
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
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(await run(uuidVariable(run_id))),
          },
        ],
      };
    },
  );
  server.registerResource(
    "rae-events",
    new ResourceTemplate("rae://runs/{run_id}/events{?cursor,limit}", { list: undefined }),
    { mimeType: "application/json" },
    async (uri, { run_id, cursor, limit }) => {
      requireScope(principal, "rae.run.read");
      await run(uuidVariable(run_id));
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(
              await store.listRunEvents(uuidVariable(run_id), {
                cursor,
                limit,
                encoding: pageEncoding(body, (page) => ({
                  contents: [
                    { uri: uri.href, mimeType: "application/json", text: JSON.stringify(page) },
                  ],
                })),
              }),
            ),
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

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Principal } from "./authorization.js";
import type { MemoryStore, PostgresStore } from "./store.js";
import type { EventPage } from "./event-pages.js";
function uuidVariable(value: string | string[] | undefined): string {
  return z.string().uuid().parse(value);
}
/** Include the JSON-RPC ID and double-escaped embedded JSON in the total response budget. */
export function pageEncoding(body: unknown, result: (page: EventPage) => unknown) {
  const id = body && typeof body === "object" && "id" in body ? body.id : null;
  return {
    eventBytes: (serialized: string) => Buffer.byteLength(JSON.stringify(serialized)) - 2,
    emptyPageBytes: (nextCursor: string | null) =>
      Buffer.byteLength(
        JSON.stringify({ jsonrpc: "2.0", id, result: result({ events: [], nextCursor }) }),
      ),
  };
}

import { MAX_RUN_NODES } from "./store.js";
