/** Cursor pagination rejects malformed state and never skips oversized historical events. */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  decodeEventCursor,
  encodeEventCursor,
  eventLimit,
  pageRunEvents,
  streamEventCursor,
  MAX_EVENT_PAGE_BYTES,
  type StoredEvent,
  type EventPageStore,
} from "../src/event-pages.js";
function store(events: StoredEvent[]): EventPageStore {
  return {
    async listRunEventsAfter(_run, after, limit) {
      return events.filter((event) => BigInt(event.id) > BigInt(after)).slice(0, limit);
    },
  };
}
test("default and maximum pages produce strict run-bound cursors", async () => {
  const source = store(
    Array.from({ length: 205 }, (_, index) => ({ id: index + 1, payload: { index } })),
  );
  const first = await pageRunEvents(source, "run-a");
  assert.equal(first.events.length, 100);
  assert.ok(first.nextCursor);
  const second = await pageRunEvents(source, "run-a", { cursor: first.nextCursor });
  assert.equal(second.events.length, 100);
  const last = await pageRunEvents(source, "run-a", { cursor: second.nextCursor });
  assert.equal(last.events.length, 5);
  assert.equal(last.nextCursor, null);
  assert.deepEqual(
    [...first.events, ...second.events, ...last.events].map((event) => event.id),
    Array.from({ length: 205 }, (_, index) => index + 1),
  );
  assert.equal(eventLimit("1000"), 1000);
  for (const value of ["", 0, -1, 1001, 1.5, "1e2", true, []])
    assert.throws(() => eventLimit(value));
  for (const cursor of ["", "100", `${first.nextCursor}=`, encodeEventCursor("run-b", 1)])
    assert.throws(() => decodeEventCursor("run-a", cursor));
  assert.throws(() => streamEventCursor("NaN"));
  assert.throws(() => streamEventCursor(-1));
  assert.equal(
    decodeEventCursor("run-a", encodeEventCursor("run-a", "9007199254740993")),
    "9007199254740993",
  );
});
test("byte limits split pages without losing events and oversized single events fail", async () => {
  const source = store(
    Array.from({ length: 5 }, (_, index) => ({ id: index + 1, payload: "é".repeat(300_000) })),
  );
  const page = await pageRunEvents(source, "run");
  assert.equal(page.events.length, 3);
  assert.ok(page.nextCursor);
  assert.ok(Buffer.byteLength(JSON.stringify(page)) <= MAX_EVENT_PAGE_BYTES);
  const rest = await pageRunEvents(source, "run", { cursor: page.nextCursor });
  assert.equal(rest.events.length, 2);
  assert.equal(rest.nextCursor, null);
  const oversized = store([{ id: 1, payload: "x".repeat(MAX_EVENT_PAGE_BYTES) }]);
  await assert.rejects(pageRunEvents(oversized, "run"), { code: "EVENT_TOO_LARGE", status: 422 });
});
test("transport envelopes are counted and invalid store ordering fails closed", async () => {
  const source = store([
    { id: 1, payload: '"'.repeat(800_000) },
    { id: 2, payload: "small" },
  ]);
  await assert.rejects(
    pageRunEvents(source, "run", {
      encoding: {
        eventBytes: (serialized) => Buffer.byteLength(JSON.stringify(serialized)) - 2,
        emptyPageBytes: (nextCursor) =>
          Buffer.byteLength(
            JSON.stringify({
              content: [{ type: "text", text: JSON.stringify({ events: [], nextCursor }) }],
            }),
          ),
      },
    }),
    { code: "EVENT_TOO_LARGE" },
  );
  await assert.rejects(
    pageRunEvents(
      {
        async listRunEventsAfter() {
          return [{ id: 2 }, { id: 1 }];
        },
      },
      "run",
    ),
    { code: "INVALID_EVENT_PAGE" },
  );
});

test("oversized historical events preserve the safe prefix and fail on the next page", async () => {
  for (const event of [
    { id: 2, oversized: true },
    { id: 2, payload: "x".repeat(MAX_EVENT_PAGE_BYTES) },
  ]) {
    const source = store([{ id: 1, payload: "safe" }, event]);
    const page = await pageRunEvents(source, "run");
    assert.deepEqual(page.events, [{ id: 1, payload: "safe" }]);
    assert.equal(decodeEventCursor("run", page.nextCursor), "1");
    await assert.rejects(pageRunEvents(source, "run", { cursor: page.nextCursor }), {
      code: "EVENT_TOO_LARGE",
      status: 422,
    });
  }
});

test("terminal HTTP and MCP pages accept exactly the byte budget", async () => {
  const mcp = (page: unknown) =>
    JSON.stringify({ content: [{ type: "text", text: JSON.stringify(page) }] });
  for (const encode of [JSON.stringify, mcp]) {
    const encoding =
      encode === JSON.stringify
        ? undefined
        : {
            eventBytes: (serialized: string) => Buffer.byteLength(JSON.stringify(serialized)) - 2,
            emptyPageBytes: (nextCursor: string | null) =>
              Buffer.byteLength(mcp({ events: [], nextCursor })),
          };
    const overhead = Buffer.byteLength(
      encode({ events: [{ id: 1, payload: "" }], nextCursor: null }),
    );
    for (const limit of [1, 100]) {
      const event = { id: 1, payload: "x".repeat(MAX_EVENT_PAGE_BYTES - overhead) };
      const page = await pageRunEvents(store([event]), "run", { limit, encoding });
      assert.equal(page.nextCursor, null);
      assert.equal(Buffer.byteLength(encode(page)), MAX_EVENT_PAGE_BYTES);
      await assert.rejects(
        pageRunEvents(store([{ ...event, payload: `${event.payload}x` }]), "run", {
          limit,
          encoding,
        }),
        {
          code: "EVENT_TOO_LARGE",
        },
      );
    }
  }
});

test("empty pages validate transport accounting and lookahead validates ordering", async () => {
  for (const value of [NaN, -1, 1.5]) {
    await assert.rejects(
      pageRunEvents(store([]), "run", {
        encoding: { eventBytes: () => 0, emptyPageBytes: () => value },
      }),
      { code: "INVALID_EVENT_PAGE" },
    );
  }
  await assert.rejects(
    pageRunEvents(
      {
        async listRunEventsAfter() {
          return [{ id: 1 }];
        },
      },
      "run",
      { limit: 1 },
    ),
    { code: "INVALID_EVENT_PAGE" },
  );
});
