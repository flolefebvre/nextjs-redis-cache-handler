import { expect, onTestFinished, test, vi } from "vitest";

import { createReporter, type CacheErrorOp, type CacheEvent } from "./events.js";

const HIT: CacheEvent = { type: "hit", key: "key", durationMs: 1.25 };

function withPhase(phase: string | undefined): void {
  const previous = process.env.NEXT_PHASE;
  if (phase === undefined) delete process.env.NEXT_PHASE;
  else process.env.NEXT_PHASE = phase;
  onTestFinished(() => {
    if (previous === undefined) delete process.env.NEXT_PHASE;
    else process.env.NEXT_PHASE = previous;
  });
}

test("an event reaches the hook the caller gave", () => {
  const seen: CacheEvent[] = [];
  const reporter = createReporter({ onEvent: (event) => seen.push(event) });

  reporter.emit(HIT);

  expect(seen).toEqual([HIT]);
});

test("an error reaches the hook the caller gave, with the operation it failed in", () => {
  const seen: [unknown, CacheErrorOp][] = [];
  const failure = new Error("WRONGTYPE");
  const reporter = createReporter({ onError: (error, op) => seen.push([error, op]) });

  reporter.fail(failure, "get");

  expect(seen).toEqual([[failure, "get"]]);
});

test("a hook that throws is swallowed, and the hooks after it still run", () => {
  const reporter = createReporter({
    debug: true,
    onEvent: () => {
      throw new Error("hook");
    },
  });
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

  expect(() => reporter.emit(HIT)).not.toThrow();
  expect(log).toHaveBeenCalledTimes(1);
});

test("an error hook that throws is swallowed", () => {
  const reporter = createReporter({
    onError: () => {
      throw new Error("hook");
    },
  });

  expect(() => reporter.fail(new Error("WRONGTYPE"), "set")).not.toThrow();
});

test("with no error hook and no debug, an error reaches console.error once", () => {
  const reporter = createReporter({});
  const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const failure = new Error("WRONGTYPE");

  reporter.fail(failure, "refreshTags");

  expect(error).toHaveBeenCalledTimes(1);
  expect(error.mock.calls[0]).toContain(failure);
  expect(error.mock.calls[0]).toContain("refreshTags");
});

test("an error hook of the caller's replaces the console default", () => {
  const reporter = createReporter({ onError: () => undefined });
  const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

  reporter.fail(new Error("WRONGTYPE"), "updateTags");

  expect(error).not.toHaveBeenCalled();
});

test("debug replaces the console default, and coexists with the caller's error hook", () => {
  const seen: CacheErrorOp[] = [];
  const reporter = createReporter({ debug: true, onError: (_error, op) => seen.push(op) });
  const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

  reporter.fail(new Error("WRONGTYPE"), "connect");

  expect(seen).toEqual(["connect"]);
  expect(error).toHaveBeenCalledTimes(1);
  expect(String(error.mock.calls[0]?.[0])).toContain("connect");
});

test("debug logs one line per event, stamped with the Next.js phase", () => {
  withPhase("phase-production-server");
  const reporter = createReporter({ debug: true });
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

  reporter.emit({ type: "miss", reason: "absent", key: "posts", durationMs: 2 });

  expect(log).toHaveBeenCalledTimes(1);
  expect(String(log.mock.calls[0]?.[0])).toContain("phase-production-server");
  expect(String(log.mock.calls[0]?.[0])).toContain("miss");
  expect(String(log.mock.calls[0]?.[0])).toContain("absent");
  expect(String(log.mock.calls[0]?.[0])).toContain("posts");
});

test("debug stamps a placeholder when the phase is unset", () => {
  withPhase(undefined);
  const reporter = createReporter({ debug: true });
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

  reporter.emit({ type: "skip", reason: "too-large", size: 42, key: "big", durationMs: 0 });

  expect(String(log.mock.calls[0]?.[0])).toContain("no-phase");
  expect(String(log.mock.calls[0]?.[0])).toContain("too-large");
  expect(String(log.mock.calls[0]?.[0])).toContain("42");
});

test("with no hook and no debug, an event is dropped without touching the console", () => {
  const reporter = createReporter({});
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

  reporter.emit(HIT);

  expect(log).not.toHaveBeenCalled();
});
