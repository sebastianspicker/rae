/** Verifies the HTTP handler enforces its authenticated loopback trust boundary. */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import test from "node:test";
import { handleOperatorRequest } from "../server.mjs";
import { OperatorProfiles } from "../lib/profiles.mjs";
import { WorkflowProposalJobs } from "../lib/proposals.mjs";

class MockRequest extends Readable {
  constructor({ path = "/", method = "GET", headers = {}, body = "" } = {}) {
    super();
    this.url = path;
    this.method = method;
    this.headers = headers;
    this.body = Buffer.from(body);
  }

  _read() {
    this.push(this.body);
    this.push(null);
  }
}

class MockResponse extends EventEmitter {
  constructor() {
    super();
    this.headersSent = false;
    this.statusCode = null;
    this.headers = {};
    this.chunks = [];
  }

  writeHead(status, headers) {
    this.statusCode = status;
    this.headers = headers;
    this.headersSent = true;
  }

  write(value) {
    this.chunks.push(Buffer.from(value));
    return true;
  }
  end(value) {
    if (value) this.write(value);
    this.emit("finish");
  }
  get body() {
    return Buffer.concat(this.chunks).toString("utf8");
  }
}

const token = "test-token-that-is-long-enough";
const host = "127.0.0.1:4173";
const origin = `http://${host}`;
const project = { id: "project_12345678", root: "/tmp", label: "/tmp" };

function requestContext(controller, workflowRegistry, remote) {
  return { token, host, origin, projects: [project], controller, workflowRegistry, remote };
}

async function dispatch(options, controller, workflowRegistry, remote) {
  const req = new MockRequest(options);
  const res = new MockResponse();
  await handleOperatorRequest(req, res, requestContext(controller, workflowRegistry, remote));
  return res;
}

test("static app has strict CSP and no inline script", async () => {
  const res = await dispatch({ headers: { host } }, {});
  assert.equal(res.statusCode, 200);
  assert.match(res.headers["content-security-policy"], /script-src 'self'/);
  assert.doesNotMatch(res.body, /<script(?![^>]*src=)/);
});

test("API requires exact Host, exact state-changing Origin, and bearer auth without CORS", async () => {
  const controller = {
    ownedRunId: null,
    refreshOwnership: () => null,
    start: () => ({ accepted: true, run_id: null }),
  };
  const unauthenticated = await dispatch(
    { path: "/api/v1/projects", headers: { host } },
    controller,
  );
  assert.equal(unauthenticated.statusCode, 401);
  assert.equal(unauthenticated.headers["access-control-allow-origin"], undefined);

  const wrongHost = await dispatch(
    {
      path: "/api/v1/projects",
      headers: { host: "localhost:4173", authorization: `Bearer ${token}` },
    },
    controller,
  );
  assert.equal(wrongHost.statusCode, 421);

  const projects = await dispatch(
    { path: "/api/v1/projects", headers: { host, authorization: `Bearer ${token}` } },
    controller,
  );
  assert.equal(projects.statusCode, 200);
  assert.equal(JSON.parse(projects.body).projects[0].id, project.id);

  const body = JSON.stringify({ task: "safe" });
  const missingOrigin = await dispatch(
    {
      path: `/api/v1/projects/${project.id}/runs`,
      method: "POST",
      body,
      headers: {
        host,
        authorization: `Bearer ${token}`,
        "content-length": Buffer.byteLength(body),
      },
    },
    controller,
  );
  assert.equal(missingOrigin.statusCode, 403);

  const accepted = await dispatch(
    {
      path: `/api/v1/projects/${project.id}/runs`,
      method: "POST",
      body,
      headers: {
        host,
        origin,
        authorization: `Bearer ${token}`,
        "content-length": Buffer.byteLength(body),
      },
    },
    controller,
  );
  assert.equal(accepted.statusCode, 202);
});

test("API rejects bodies declared above 64KiB before control dispatch", async () => {
  let called = false;
  const res = await dispatch(
    {
      path: `/api/v1/projects/${project.id}/runs`,
      method: "POST",
      body: "{}",
      headers: {
        host,
        origin,
        authorization: `Bearer ${token}`,
        "content-length": String(70 * 1024),
        "content-type": "application/json",
      },
    },
    {
      ownedRunId: null,
      refreshOwnership: () => null,
      start: () => {
        called = true;
      },
    },
  );
  assert.equal(res.statusCode, 413);
  assert.equal(called, false);
});

test("remote mode keeps browser authentication at loopback and delegates only after it succeeds", async () => {
  const calls = [];
  const remote = {
    forward: async (req, url) => {
      calls.push({ authorization: req.headers.authorization, path: url.pathname });
      return {
        status: 200,
        contentType: "application/json; charset=utf-8",
        body: Buffer.from('{"projects":[{"id":"remote"}]}\n'),
      };
    },
  };
  const controller = { refreshOwnership: () => null };
  const rejected = await dispatch(
    { path: "/api/v1/projects", headers: { host, authorization: "Bearer wrong" } },
    controller,
    undefined,
    remote,
  );
  assert.equal(rejected.statusCode, 401);
  assert.equal(calls.length, 0);
  const proxied = await dispatch(
    { path: "/api/v1/projects", headers: { host, authorization: `Bearer ${token}` } },
    controller,
    undefined,
    remote,
  );
  assert.equal(proxied.statusCode, 200);
  assert.equal(JSON.parse(proxied.body).projects[0].id, "remote");
  assert.deepEqual(calls, [{ authorization: `Bearer ${token}`, path: "/api/v1/projects" }]);
  assert.equal(proxied.headers["access-control-allow-origin"], undefined);
});

test("remote mode forwards bounded event-stream chunks without granting browser upstream access", async () => {
  const remote = {
    forward: async () => ({
      status: 200,
      contentType: "application/x-ndjson; charset=utf-8",
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue(Buffer.from('{"event":"remote"}\n'));
          controller.close();
        },
      }),
    }),
  };
  const res = await dispatch(
    {
      path: `/api/v1/projects/${project.id}/runs/run_12345678/events/stream?after=0`,
      headers: { host, authorization: `Bearer ${token}` },
    },
    { refreshOwnership: () => null },
    undefined,
    remote,
  );
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["content-type"], "application/x-ndjson; charset=utf-8");
  assert.equal(res.body, '{"event":"remote"}\n');
});

test("workflow editor API keeps registry mutations authenticated and rejects active-run edits", async () => {
  const calls = [];
  const registry = {
    list: () => [{ id: "release", active_revision: "3" }],
    show: (id) => ({ id, revisions: ["2", "3"] }),
    draft: (id, body) => {
      calls.push(["draft", id, body]);
      return { id: "4", status: "draft" };
    },
    validate: (id, revision) => ({ id, revision, valid: true }),
    diff: (id, query) => ({ id, ...query, changes: [] }),
    activate: (id, revision) => ({ id, revision, activated: true }),
  };
  const controller = { ownedRunId: null, refreshOwnership: () => null };
  const list = await dispatch(
    {
      path: `/api/v1/projects/${project.id}/workflows`,
      headers: { host, authorization: `Bearer ${token}` },
    },
    controller,
    registry,
  );
  assert.equal(list.statusCode, 200);
  assert.equal(JSON.parse(list.body).workflows[0].id, "release");
  const body = JSON.stringify({ base_revision: "3", definition: { stages: [] } });
  const draft = await dispatch(
    {
      path: `/api/v1/projects/${project.id}/workflows/release/drafts`,
      method: "POST",
      body,
      headers: {
        host,
        origin,
        authorization: `Bearer ${token}`,
        "content-length": Buffer.byteLength(body),
      },
    },
    controller,
    registry,
  );
  assert.equal(draft.statusCode, 201);
  assert.deepEqual(calls[0][2], JSON.parse(body));
  controller.ownedRunId = "run_12345678";
  const blocked = await dispatch(
    {
      path: `/api/v1/projects/${project.id}/workflows/release/revisions/4/activate`,
      method: "POST",
      body: "{}",
      headers: { host, origin, authorization: `Bearer ${token}`, "content-length": "2" },
    },
    controller,
    registry,
  );
  assert.equal(blocked.statusCode, 409);
});

test("execution-profile discovery is sanitized and run start resolves only an allowlisted id", async () => {
  const profiles = new OperatorProfiles([
    {
      source: "/private/never-exposed.json",
      profile: {
        profile_id: "local-codex",
        schema_version: "1.0.0",
        tiers: {
          economy: { model: "small", reasoning_effort: "low" },
          standard: { model: "standard", reasoning_effort: "medium" },
          judgment: { model: "judge", reasoning_effort: "high" },
        },
      },
    },
  ]);
  let passedProfile = null;
  const controller = {
    ownedRunId: null,
    refreshOwnership: () => null,
    start(_project, _body, profile) {
      passedProfile = profile;
      return { accepted: true, run_id: null };
    },
  };
  const context = { ...requestContext(controller), profiles };
  const listRequest = new MockRequest({
    path: `/api/v1/projects/${project.id}/execution-profiles`,
    headers: { host, authorization: `Bearer ${token}` },
  });
  const listResponse = new MockResponse();
  await handleOperatorRequest(listRequest, listResponse, context);
  assert.equal(listResponse.statusCode, 200);
  assert.deepEqual(JSON.parse(listResponse.body).profiles, [
    {
      id: "local-codex",
      routes: [
        { id: "economy", executor: "codex", model: "small", reasoning_effort: "low" },
        { id: "judgment", executor: "codex", model: "judge", reasoning_effort: "high" },
        { id: "standard", executor: "codex", model: "standard", reasoning_effort: "medium" },
      ],
      models: { economy: "small", standard: "standard", judgment: "judge" },
      readiness: "loaded",
    },
  ]);
  assert.doesNotMatch(listResponse.body, /private|env|credential/i);
  const body = JSON.stringify({ task: "safe", execution_profile_id: "local-codex" });
  const startRequest = new MockRequest({
    path: `/api/v1/projects/${project.id}/runs`,
    method: "POST",
    body,
    headers: {
      host,
      origin,
      authorization: `Bearer ${token}`,
      "content-length": Buffer.byteLength(body),
    },
  });
  const startResponse = new MockResponse();
  await handleOperatorRequest(startRequest, startResponse, context);
  assert.equal(startResponse.statusCode, 202);
  assert.equal(passedProfile.source, "/private/never-exposed.json");
});

test("proposal jobs are authenticated, bounded, and return an unsaved candidate only", async () => {
  const proposalJobs = new WorkflowProposalJobs({
    candidateRunner: async () => ({
      schema_version: "2.1.0",
      workflow_id: "release",
      revision: 4,
      entry_node: "plan",
      terminal_node: "finish",
      nodes: [
        { id: "plan", kind: "agent", access: "read", guidance: "Plan safely." },
        {
          id: "verify",
          kind: "gate",
          access: "read",
          guidance: "Verify acceptance criteria.",
          verification: true,
        },
        { id: "finish", kind: "terminal", access: "control", guidance: "Record outcome." },
      ],
      edges: [
        { from: "plan", to: "verify", type: "sequence" },
        { from: "verify", to: "finish", type: "sequence" },
      ],
    }),
  });
  const registry = { show: () => ({ workflow_id: "release" }) };
  const context = {
    ...requestContext({ ownedRunId: null, refreshOwnership: () => null }, registry),
    proposalJobs,
  };
  const body = JSON.stringify({ task: "Add a checkpoint" });
  const request = new MockRequest({
    path: `/api/v1/projects/${project.id}/workflows/release/proposals`,
    method: "POST",
    body,
    headers: {
      host,
      origin,
      authorization: `Bearer ${token}`,
      "content-length": Buffer.byteLength(body),
    },
  });
  const response = new MockResponse();
  await handleOperatorRequest(request, response, context);
  assert.equal(response.statusCode, 202);
  const job = JSON.parse(response.body);
  await new Promise((resolve) => setImmediate(resolve));
  const result = proposalJobs.get(job.id);
  assert.equal(result.state, "completed");
  assert.equal(result.candidate.workflow_id, "release");
  assert.equal("activation" in result, false);
  assert.equal("revision" in result, false);
});

test("guided templates compile to workflow 2.1 and unsaved analysis is authenticated", async () => {
  const context = requestContext(
    { ownedRunId: null, refreshOwnership: () => null },
    { list: () => [], show: () => ({ workflow_id: "release" }) },
  );
  const listRequest = new MockRequest({
    path: `/api/v1/projects/${project.id}/workflows/templates`,
    headers: { host, authorization: `Bearer ${token}` },
  });
  const listResponse = new MockResponse();
  await handleOperatorRequest(listRequest, listResponse, context);
  assert.equal(listResponse.statusCode, 200);
  assert.equal(JSON.parse(listResponse.body).templates.length, 5);

  const compileBody = JSON.stringify({
    template_id: "maker-checker-repair",
    workflow_id: "release",
    revision: 4,
  });
  const compileRequest = new MockRequest({
    path: `/api/v1/projects/${project.id}/workflows/templates`,
    method: "POST",
    body: compileBody,
    headers: {
      host,
      origin,
      authorization: `Bearer ${token}`,
      "content-length": Buffer.byteLength(compileBody),
    },
  });
  const compileResponse = new MockResponse();
  await handleOperatorRequest(compileRequest, compileResponse, context);
  assert.equal(compileResponse.statusCode, 200);
  const workflow = JSON.parse(compileResponse.body).workflow;
  assert.equal(workflow.schema_version, "2.1.0");
  assert.equal(workflow.workflow_id, "release");
  assert.equal(workflow.revision, 4);

  const analysisBody = JSON.stringify({ workflow });
  const analysisRequest = new MockRequest({
    path: `/api/v1/projects/${project.id}/workflows/release/analysis`,
    method: "POST",
    body: analysisBody,
    headers: {
      host,
      origin,
      authorization: `Bearer ${token}`,
      "content-length": Buffer.byteLength(analysisBody),
    },
  });
  const analysisResponse = new MockResponse();
  await handleOperatorRequest(analysisRequest, analysisResponse, context);
  assert.equal(analysisResponse.statusCode, 200);
  const analyzed = JSON.parse(analysisResponse.body);
  assert.equal(analyzed.available, true);
  assert.equal(analyzed.analysis.valid, true);
  assert.equal(analyzed.analysis.monetary_cost.status, "unavailable");
});

test("proposal profile IDs resolve only to preloaded server paths", async () => {
  let candidateInput = null;
  const proposalJobs = new WorkflowProposalJobs({
    candidateRunner: async (input) => {
      candidateInput = input;
      return {
        schema_version: "2.1.0",
        workflow_id: "release",
        revision: 4,
        entry_node: "plan",
        terminal_node: "finish",
        nodes: [
          { id: "plan", kind: "agent", access: "read", guidance: "Plan safely." },
          {
            id: "verify",
            kind: "gate",
            access: "control",
            guidance: "Verify acceptance criteria.",
            verification: true,
          },
          {
            id: "finish",
            kind: "terminal",
            access: "control",
            guidance: "Record outcome.",
          },
        ],
        edges: [
          { from: "plan", to: "verify", type: "sequence" },
          { from: "verify", to: "finish", type: "sequence" },
        ],
      };
    },
  });
  const profiles = new OperatorProfiles([
    {
      source: "/server/profiles/review.json",
      profile: {
        schema_version: "3.0.0",
        profile_id: "local-review",
        routes: { review: { executor: "opencode", model: "opencode/example" } },
        tiers: { economy: "review", standard: "review", judgment: "review" },
      },
    },
  ]);
  const context = {
    ...requestContext(
      { ownedRunId: null, refreshOwnership: () => null },
      { show: () => ({ workflow_id: "release" }) },
    ),
    profiles,
    proposalJobs,
  };
  const body = JSON.stringify({
    task: "Add a bounded review",
    execution_profile_id: "local-review",
  });
  const request = new MockRequest({
    path: `/api/v1/projects/${project.id}/workflows/release/proposals`,
    method: "POST",
    body,
    headers: {
      host,
      origin,
      authorization: `Bearer ${token}`,
      "content-length": Buffer.byteLength(body),
    },
  });
  const response = new MockResponse();
  await handleOperatorRequest(request, response, context);
  assert.equal(response.statusCode, 202);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(candidateInput.executionProfile, "/server/profiles/review.json");
  assert.doesNotMatch(response.body, /server|profiles|review\.json/);
});
