import { randomUUID } from "node:crypto";
import { createClient } from "redis";
import { inject, onTestFinished } from "vitest";

import type { CacheErrorHook, CacheErrorOp, CacheEvent, CacheEventHook } from "../src/events.js";
import type { RedisCacheHandlerOptions } from "../src/options.js";
import { createRedisCacheHandler } from "../src/redis-cache-handler.js";
import type { CacheEntry, CacheHandler } from "../src/types.js";
import { stopwatch } from "./unit-harness.js";

const TICK_MS = 5;

const SETTLE_TIMEOUT_MS = 5_000;

const ARGUMENT = /"((?:[^"\\]|\\.)*)"/g;

/** A value with bytes no UTF-8 decoder would give back, as an RSC payload has. */
export const VALUE = Uint8Array.from([0x00, 0xff, 0xfe, 0x80, 0x01, 0xc3, 0x28]);

/** A Key prefix no other test uses, so that tests never clean anything up. */
export function freshPrefix(): string {
  return `cache-test:${randomUUID()}:`;
}

/** One Instance's handler object on the given Key prefix, closed when the test ends. */
export function handlerFor(
  keyPrefix: string,
  overrides: Partial<RedisCacheHandlerOptions> = {},
): ReturnType<typeof createRedisCacheHandler> {
  const handler = createRedisCacheHandler({ url: inject("redisUrl"), keyPrefix, ...overrides });
  onTestFinished(() => handler.close());

  return handler;
}

/**
 * Hooks that collect what a handler reports, and what they have collected so far. The
 * hooks are grouped under `hooks` because that object is handed to the factory as it is,
 * and the factory rejects any key that is not an option.
 */
export function recording(): {
  events: CacheEvent[];
  errors: [unknown, CacheErrorOp][];
  hooks: { onEvent: CacheEventHook; onError: CacheErrorHook };
} {
  const events: CacheEvent[] = [];
  const errors: [unknown, CacheErrorOp][] = [];

  return {
    events,
    errors,
    hooks: {
      onEvent: (event) => events.push(event),
      onError: (error, op) => errors.push([error, op]),
    },
  };
}

/** The operations the recorded errors were reported for, in order. */
export function opsOf(errors: [unknown, CacheErrorOp][]): CacheErrorOp[] {
  return errors.map(([, op]) => op);
}

/** Two Instances of one app: two handler objects on one fresh Key prefix. */
export function instancePair(): {
  keyPrefix: string;
  instanceA: ReturnType<typeof handlerFor>;
  instanceB: ReturnType<typeof handlerFor>;
} {
  const keyPrefix = freshPrefix();

  return { keyPrefix, instanceA: handlerFor(keyPrefix), instanceB: handlerFor(keyPrefix) };
}

/** What `serverClient()` hands back, for the helpers that take one. */
export type ServerClient = Awaited<ReturnType<typeof serverClient>>;

/**
 * A plain client on the shared server of the run, or on the one whose URL is given, to
 * observe what the handler wrote. A test that owns a server of its own hands over its URL.
 */
export async function serverClient(url: string = inject("redisUrl")) {
  const client = createClient({ url });
  client.on("error", () => undefined);
  await client.connect();
  onTestFinished(() => client.close());

  return client;
}

/** The value of an Entry, as the one-chunk stream Next.js hands `set`. */
export function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

/** The bytes a returned Entry streams back. */
export async function bytesOf(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) chunks.push(chunk);

  return Uint8Array.from(Buffer.concat(chunks));
}

/** A real pause of `ms` milliseconds. */
export function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A real pause long enough for the server clock to move on. Tag events and Write times
 * are compared strictly, so a test that means "before" must not land on the same
 * millisecond.
 */
export function tick(): Promise<void> {
  return wait(TICK_MS);
}

/** An Entry as Next.js would hand it to `set`, with the given overrides. */
export function entryOf(overrides: Partial<CacheEntry> = {}): CacheEntry {
  return {
    value: streamOf(VALUE),
    tags: ["posts", "post:1"],
    stale: 300,
    timestamp: Date.now(),
    expire: 900,
    revalidate: 60,
    ...overrides,
  };
}

/**
 * An Entry stored by one Instance, with the clock moved on afterwards so that a tag event
 * issued next is unambiguously later than the Entry's Write time.
 */
export async function storeBefore(
  instance: CacheHandler,
  cacheKey: string,
  overrides: Partial<CacheEntry> = {},
): Promise<void> {
  await instance.set(cacheKey, Promise.resolve(entryOf(overrides)));
  await tick();
}

/** What one Instance reads for `cacheKey` once it has taken in the latest tag events. */
export async function readAfterRefresh(
  instance: CacheHandler,
  cacheKey: string,
  softTags: string[] = [],
): Promise<CacheEntry | undefined> {
  await instance.refreshTags();

  return instance.get(cacheKey, softTags);
}

/** Everything a returned Entry carries besides its value. */
export function timingsOf(entry: CacheEntry): Omit<CacheEntry, "value"> {
  return {
    tags: entry.tags,
    stale: entry.stale,
    timestamp: entry.timestamp,
    expire: entry.expire,
    revalidate: entry.revalidate,
  };
}

/** What the server ran, as `MONITOR` reported it: one array of arguments per command. */
export interface CommandStream {
  /**
   * Every command the server has run on this Key prefix since the stream was opened.
   * A marker command is sent and awaited first, so that everything the server ran before
   * this call has reached the stream, and the watching stops as it returns: `MONITOR`
   * feeds one connection every command of the whole server, which slows every other test
   * running against it.
   */
  settled(): Promise<string[][]>;
}

/**
 * Watch what the server runs on one Key prefix, on a connection of its own. `MONITOR`
 * reports the commands a Lua script runs as well as the `EVALSHA` that started it, so a
 * read of the Tag manifest shows up as both. The stream is global, so only the commands
 * carrying this test's Key prefix are kept: a command with no key of ours in it, `TIME`
 * among them, cannot be told from another test's.
 */
export async function commandStream(keyPrefix: string): Promise<CommandStream> {
  const commands: string[][] = [];
  const monitor = createClient({ url: inject("redisUrl") });
  monitor.on("error", () => undefined);
  await monitor.connect();
  onTestFinished(() => monitor.close().catch(() => undefined));
  await monitor.monitor((line) => {
    const command = argumentsOf(String(line));
    if (command.some((argument) => argument.includes(keyPrefix))) commands.push(command);
  });
  const marker = await serverClient();

  return {
    async settled(): Promise<string[][]> {
      const token = `${keyPrefix}settled:${randomUUID()}`;
      const seen = (): boolean => commands.some((command) => command.includes(token));
      await marker.echo(token);

      const elapsed = stopwatch();
      while (!seen()) {
        if (elapsed() > SETTLE_TIMEOUT_MS) throw new Error("the command stream never settled");
        await wait(TICK_MS);
      }
      await monitor.close();

      return commands.filter((command) => !command.includes(token));
    },
  };
}

/** The names, uppercased, of the commands that carried the Tag manifest or its log. */
export function tagCommandNames(commands: string[][], keyPrefix: string): string[] {
  return commands
    .filter((command) => command.some((argument) => argument.startsWith(`${keyPrefix}{tags}`)))
    .map((command) => (command[0] ?? "").toUpperCase());
}

function argumentsOf(line: string): string[] {
  return [...line.matchAll(ARGUMENT)].map(([, argument]) => argument ?? "");
}

/** The Redis clock in milliseconds, as the handler's scripts read it. */
export async function serverNow(server: ServerClient): Promise<number> {
  const [seconds, microseconds] = await server.time();

  return Number(seconds) * 1000 + Math.floor(Number(microseconds) / 1000);
}

/**
 * Put tag events straight into the shared Tag manifest, at an instant of the Redis clock
 * the test chooses: what the write script would have written then, in the layout the
 * handler reads back. An event a test needs to be old is written old rather than waited
 * for, so that nothing depends on the app clock and the server clock advancing together.
 */
export async function seedTagEvents(
  server: ServerClient,
  keyPrefix: string,
  tags: readonly string[],
  staleAt: number,
  expiredAt: number,
): Promise<void> {
  await server.hSet(
    `${keyPrefix}{tags}`,
    Object.fromEntries(tags.map((tag) => [tag, `${staleAt}:${expiredAt}`])),
  );
  await server.zAdd(
    `${keyPrefix}{tags}:log`,
    tags.map((tag) => ({ score: staleAt, value: tag })),
  );
}
