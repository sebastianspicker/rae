/** Checks incremental DOM ownership without a browser dependency; rendered QA is a separate lane. */
import assert from "node:assert/strict";
import test from "node:test";

let createdRows = 0;
class Element {
  constructor(tag) {
    this.tagName = tag;
    this.children = [];
    this.attributes = {};
    this.listeners = {};
    this.dataset = {};
  }
  append(...children) {
    this.children.push(...children);
  }
  replaceChildren(...children) {
    this.children = children;
  }
  setAttribute(key, value) {
    this.attributes[key] = value;
  }
  getAttribute(key) {
    return this.attributes[key];
  }
  addEventListener(name, callback) {
    this.listeners[name] = callback;
  }
  focus() {
    document.activeElement = this;
  }
}
const registry = new Map();
const create = (tag) => {
  if (tag === "tr") createdRows++;
  return new Element(tag);
};
globalThis.document = {
  createElement: create,
  createElementNS: (_namespace, tag) => create(tag),
  createTextNode: (text) => ({ textContent: text }),
  getElementById(id) {
    if (!registry.has(id)) registry.set(id, create("div"));
    return registry.get(id);
  },
};
globalThis.location = { hash: "", pathname: "/", search: "" };
const { state, elements } = await import("../static/js/state.js");
const { renderEvents } = await import("../static/js/render.js");
const event = (seq) => ({ seq, event: "agent_call", phase: "arm", status: "pass" });

test("new events append stable rows, preserve detail state/focus and retain the complete history", () => {
  state.events = [event(1)];
  renderEvents();
  const first = elements["event-list"].children[0];
  const detail = elements["event-list"].children[1];
  const toggle = first.children[0].children[0];
  toggle.listeners.click();
  toggle.focus();
  createdRows = 0;
  state.events.push(...Array.from({ length: 9999 }, (_, index) => event(index + 2)));
  renderEvents();
  assert.equal(createdRows, 19998);
  assert.equal(elements["event-list"].children.length, 20000);
  assert.strictEqual(elements["event-list"].children[0], first);
  assert.strictEqual(document.activeElement, toggle);
  assert.equal(detail.hidden, false);
  assert.equal(toggle.getAttribute("aria-expanded"), "true");
  createdRows = 0;
  renderEvents();
  assert.equal(createdRows, 0);
});

test("selection changes, errors and empty history reset the ledger", () => {
  state.events = [];
  renderEvents();
  assert.equal(elements["event-list"].children.length, 1);
  assert.equal(elements["event-count"].textContent, "0 projected events");
  state.eventError = "unavailable fixture";
  renderEvents();
  assert.equal(elements["event-count"].textContent, "Unavailable");
  state.eventError = null;
  state.events = [event(3)];
  renderEvents();
  assert.equal(elements["event-list"].children.length, 2);
});

test("stream chunks deduplicate by cursor and batch one pending frame", async () => {
  const frames = new Map();
  let nextFrame = 0;
  globalThis.requestAnimationFrame = (callback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  };
  globalThis.cancelAnimationFrame = (key) => frames.delete(key);
  const { setTransport } = await import("../static/js/api.js");
  const { loadEvents } = await import("../static/js/data.js");
  let stream;
  setTransport({
    async request() {
      return { events: [event(1)], next_after: 1 };
    },
    async eventStream() {
      return new Response(
        new ReadableStream({
          start(controller) {
            stream = controller;
          },
        }),
      );
    },
  });
  state.projectId = "fixture-project";
  state.runId = "fixture-run";
  await loadEvents();
  const encoder = new TextEncoder();
  for (const seq of [2, 2, 3, 3]) stream.enqueue(encoder.encode(`${JSON.stringify(event(seq))}\n`));
  await new Promise(setImmediate);
  assert.deepEqual(
    state.events.map((item) => item.seq),
    [1, 2, 3],
  );
  assert.equal(state.eventAfter, 3);
  assert.equal(frames.size, 1);
  for (const callback of frames.values()) callback();
  assert.equal(elements["event-list"].children.length, 6);
  state.streamGeneration++;
  state.streamAbort.abort();
  stream.close();
});
