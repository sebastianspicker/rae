/** Shares one bounded trace poller among all subscribers to the same run. */
import { readOperatorEventsAfter, readOperatorEventPages } from "@rae/engine";

export interface TailRun {
  id: string;
  workspaceRoot: string;
  guarded?: boolean;
  current_phase?: string;
}
export interface TailEvent {
  seq: number;
  [key: string]: unknown;
}
export interface TailDelivery {
  acceptedThrough: number;
  pause?: boolean;
}
export interface TailSubscription {
  close(): void;
  resume(): void;
}
type Listener = (events: readonly TailEvent[]) => TailDelivery;
type Reader = (
  run: TailRun,
  options: { after: number; limit: number },
) => { events: TailEvent[]; has_more: boolean };
type PageReader = (
  run: TailRun,
  options: Array<{ after: number; limit: number }>,
) => Array<ReturnType<Reader>>;
function assertReadable(run: TailRun): void {
  if (run.guarded) throw new Error("Guarded run events are unavailable");
}
const readPage: Reader = (run, options) => {
  assertReadable(run);
  return readOperatorEventsAfter(run.id, run.workspaceRoot, options);
};
const readPages: PageReader = (run, options) => {
  assertReadable(run);
  const result: Array<ReturnType<Reader>> = [];
  for (let index = 0; index < options.length; index += 128)
    result.push(
      ...readOperatorEventPages(run.id, run.workspaceRoot, options.slice(index, index + 128)),
    );
  return result;
};
interface Subscriber {
  cursor: number;
  listener: Listener;
  onError: () => void;
  paused: boolean;
}

function cursorCohorts(subscribers: Subscriber[]): Array<[number, Subscriber[]]> {
  const cohorts = new Map<number, Subscriber[]>();
  for (const subscriber of subscribers) {
    const cohort = cohorts.get(subscriber.cursor) ?? [];
    cohort.push(subscriber);
    cohorts.set(subscriber.cursor, cohort);
  }
  return [...cohorts.entries()];
}

class TailChannel {
  private readonly subscribers = new Set<Subscriber>();
  private timer: NodeJS.Timeout | null = null;
  public constructor(
    private readonly run: TailRun,
    private readonly emptyDelay: number,
    private readonly read: Reader,
    private readonly onEmpty: () => void,
    private readonly pages?: PageReader,
  ) {}

  public subscribe(after: number, listener: Listener, onError: () => void): TailSubscription {
    const subscriber: Subscriber = { cursor: after, listener, onError, paused: false };
    this.subscribers.add(subscriber);
    if (!this.timer) this.schedule(0);
    return {
      close: () => this.remove(subscriber),
      resume: () => {
        if (!this.subscribers.has(subscriber) || !subscriber.paused) return;
        subscriber.paused = false;
        if (this.timer) clearTimeout(this.timer);
        this.schedule(0);
      },
    };
  }

  private remove(subscriber: Subscriber): void {
    this.subscribers.delete(subscriber);
    if (!this.subscribers.size) {
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
      this.onEmpty();
    }
  }

  private schedule(delay: number): void {
    this.timer = setTimeout(() => this.poll(), delay);
    this.timer.unref?.();
  }

  private deliver(subscriber: Subscriber, events: TailEvent[]): void {
    if (!this.subscribers.has(subscriber)) return;
    const available = events.filter((event) => event.seq > subscriber.cursor);
    const last = available.at(-1);
    if (!last) return;
    const delivery = subscriber.listener(available);
    subscriber.cursor = Math.max(subscriber.cursor, Math.min(delivery.acceptedThrough, last.seq));
    subscriber.paused = delivery.pause === true;
  }

  private poll(): void {
    this.timer = null;
    if (!this.subscribers.size) return;
    const active = [...this.subscribers].filter((subscriber) => !subscriber.paused);
    if (!active.length) return;
    try {
      let hasMore = false;
      const entries = cursorCohorts(active);
      const requests = entries.map(([after]) => ({ after, limit: 1000 }));
      const pages = this.pages?.(this.run, requests);
      for (const [index, [after, subscribers]] of entries.entries()) {
        const raw = pages?.[index] ?? this.read(this.run, { after, limit: 1000 });
        hasMore ||= raw.has_more;
        for (const subscriber of subscribers) this.deliver(subscriber, raw.events);
      }
      if ([...this.subscribers].some((subscriber) => !subscriber.paused)) {
        this.schedule(hasMore ? 0 : this.emptyDelay);
      }
    } catch {
      for (const subscriber of [...this.subscribers]) subscriber.onError();
      this.subscribers.clear();
      this.onEmpty();
    }
  }
}

export class EventTailHub {
  private readonly channels = new Map<string, TailChannel>();
  private readonly read: Reader;
  private readonly pages: PageReader | undefined;
  public constructor(read?: Reader) {
    this.read = read ?? readPage;
    this.pages = read ? undefined : readPages;
  }
  public subscribe(
    run: TailRun,
    after: number,
    listener: Listener,
    onError: () => void,
  ): TailSubscription {
    const key = `${run.workspaceRoot}\0${run.id}`;
    let channel = this.channels.get(key);
    if (!channel) {
      channel = new TailChannel(
        run,
        750,
        this.read,
        () => {
          if (this.channels.get(key) === channel) this.channels.delete(key);
        },
        this.pages,
      );
      this.channels.set(key, channel);
    }
    return channel.subscribe(after, listener, onError);
  }
}
