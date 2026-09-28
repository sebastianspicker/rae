/** Checks incremental DOM ownership without a browser dependency; rendered QA is a separate lane. */
import assert from "node:assert/strict";
import test from "node:test";

let createdRows = 0;
type FakeNode = FakeElement | { textContent: string } | string;
class FakeElement {
  tagName: string;
  children: FakeNode[] = [];
  attributes: Record<string, string> = {};
  listeners: Record<string, () => void> = {};
  dataset: Record<string, string> = {};
  hidden = false;
  textContent = "";
  className = "";
  constructor(tag: string) {
    this.tagName = tag;
  }
  append(...children: FakeNode[]): void {
    this.children.push(...children);
  }
  replaceChildren(...children: FakeNode[]): void {
    this.children = children;
  }
  setAttribute(key: string, value: string): void {
    this.attributes[key] = value;
  }
  getAttribute(key: string): string | null {
    return this.attributes[key] ?? null;
  }
  addEventListener(name: string, callback: EventListenerOrEventListenerObject): void {
    this.listeners[name] = () =>
      typeof callback === "function"
        ? callback(new Event(name))
        : callback.handleEvent(new Event(name));
  }
  focus(): void {
    fakeDocument.activeElement = this;
  }
}
const registry = new Map<string, FakeElement>();
const create = (tag: string): FakeElement => {
  if (tag === "tr") createdRows++;
  return new FakeElement(tag);
};
const fakeDocument = {
  activeElement: null as FakeElement | null,
  createElement: create,
  createElementNS: (_namespace: string, tag: string) => create(tag),
  createTextNode: (text: string) => ({ textContent: text }),
  getElementById(id: string) {
    if (!registry.has(id)) registry.set(id, create("div"));
    return registry.get(id)!;
  },
};
globalThis.document = fakeDocument as unknown as Document;
globalThis.location = { hash: "", pathname: "/", search: "" } as Location;
const { state, elements } = await import("../static/js/state.js");
const { renderEvents } = await import("../static/js/render.js");
const event = (seq: number) => ({ seq, event: "agent_call", phase: "arm", status: "pass" });

test("new events append stable rows, preserve detail state/focus and retain the complete history", () => {
  state.events = [event(1)];
  renderEvents();
  const eventList = elements["event-list"] as unknown as FakeElement;
  const first = eventList.children[0] as FakeElement;
  const detail = eventList.children[1] as FakeElement;
  const toggle = (first.children[0] as FakeElement).children[0] as FakeElement;
  toggle.listeners.click();
  toggle.focus();
  createdRows = 0;
  state.events.push(...Array.from({ length: 9999 }, (_, index) => event(index + 2)));
  renderEvents();
  assert.equal(createdRows, 19998);
  assert.equal(eventList.children.length, 20000);
  assert.strictEqual(eventList.children[0], first);
  assert.strictEqual(fakeDocument.activeElement, toggle);
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
  let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
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
  for (const seq of [2, 2, 3, 3])
    stream!.enqueue(encoder.encode(`${JSON.stringify(event(seq))}\n`));
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
  state.streamAbort?.abort();
  stream!.close();
});

test("initial history drains every page before opening the live tail", async () => {
  const { setTransport } = await import("../static/js/api.js");
  const { loadEvents } = await import("../static/js/data.js");
  const requested = [];
  let streamedAfter = -1;
  setTransport({
    async request(path) {
      requested.push(path);
      const after = Number(new URL(path, "https://fixture.invalid").searchParams.get("after"));
      return after === 0
        ? { events: [event(1), event(2)], next_after: 2, has_more: true }
        : { events: [event(3)], next_after: 3, has_more: false };
    },
    async eventStream(path) {
      streamedAfter = Number(new URL(path, "https://fixture.invalid").searchParams.get("after"));
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.close();
          },
        }),
      );
    },
  });
  state.projectId = "fixture-project";
  state.runId = "fixture-run";
  await loadEvents();
  assert.equal(requested.length, 2);
  assert.deepEqual(
    state.events.map((item) => item.seq),
    [1, 2, 3],
  );
  assert.equal(streamedAfter, 3);
  state.streamGeneration++;
  state.streamAbort?.abort();
});

test("run catalogue appends a second summary page without changing selection", async () => {
  const { setTransport } = await import("../static/js/api.js");
  const { loadMoreRuns } = await import("../static/js/data.js");
  state.projectId = "fixture-project";
  state.runId = "run-1";
  state.runsGeneration += 1;
  state.runs = [event(1) as unknown as (typeof state.runs)[number]];
  state.runs[0]!.id = "run-1";
  state.runsCursor = "opaque-page-2";
  state.runsHasMore = true;
  setTransport({
    async request(path) {
      assert.match(path, /cursor=opaque-page-2/u);
      return { runs: [{ id: "run-2", task: "second" }], next_cursor: null };
    },
  });
  await loadMoreRuns();
  assert.deepEqual(
    state.runs.map((run) => run.id),
    ["run-1", "run-2"],
  );
  assert.equal(state.runId, "run-1");
  assert.equal(state.runsHasMore, false);
});
