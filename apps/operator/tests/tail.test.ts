/** Verifies that concurrent clients share one per-run trace polling subscription. */
import assert from "node:assert/strict";
import test from "node:test";
import { EventTailHub, type TailEvent } from "../lib/tail.js";

test("shares one trace read and fans new events out to each subscriber", async () => {
  let reads = 0;
  const hub = new EventTailHub((_run, { after }) => {
    reads += 1;
    return { events: after < 1 ? [{ seq: 1, event: "ready" }] : [], has_more: false };
  });
  const received: TailEvent[][] = [[], []];
  const run = { id: "run-1", workspaceRoot: "/fixture" };
  const subscriptions = received.map((bucket) =>
    hub.subscribe(
      run,
      0,
      (events) => {
        bucket.push(...events);
        return { acceptedThrough: events.at(-1)!.seq };
      },
      () => assert.fail("unexpected tail error"),
    ),
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  subscriptions.forEach((subscription) => {
    subscription.close();
  });
  assert.equal(reads, 1);
  assert.deepEqual(
    received.map((bucket) => bucket.map((event) => event.seq)),
    [[1], [1]],
  );
});

test("a paused subscriber neither replays accepted events nor stalls a fast subscriber", async () => {
  const hub = new EventTailHub((_run, { after }) => ({
    events: after < 3 ? [{ seq: after + 1 }] : [],
    has_more: after < 3,
  }));
  const run = { id: "run-2", workspaceRoot: "/fixture" };
  const fast: number[] = [];
  const slow: number[] = [];
  const fastSubscription = hub.subscribe(
    run,
    0,
    (events) => {
      fast.push(...events.map((event) => event.seq));
      return { acceptedThrough: events.at(-1)!.seq };
    },
    () => assert.fail("unexpected tail error"),
  );
  let pause = true;
  const slowSubscription = hub.subscribe(
    run,
    0,
    (events) => {
      slow.push(...events.map((event) => event.seq));
      const acceptedThrough = events.at(-1)!.seq;
      if (pause) {
        pause = false;
        return { acceptedThrough, pause: true };
      }
      return { acceptedThrough };
    },
    () => assert.fail("unexpected tail error"),
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(fast, [1, 2, 3]);
  assert.deepEqual(slow, [1]);
  slowSubscription.resume();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(slow, [1, 2, 3]);
  fastSubscription.close();
  slowSubscription.close();
});
