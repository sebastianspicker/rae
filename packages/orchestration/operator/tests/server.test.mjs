/** Verifies the HTTP handler enforces its authenticated loopback trust boundary. */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import test from "node:test";
import { handleOperatorRequest } from "../server.mjs";

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

function requestContext(controller) {
  return { token, host, origin, projects: [project], controller };
}

async function dispatch(options, controller) {
  const req = new MockRequest(options);
  const res = new MockResponse();
  await handleOperatorRequest(req, res, requestContext(controller));
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
