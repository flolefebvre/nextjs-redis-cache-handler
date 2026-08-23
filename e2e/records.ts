import { readFile } from "node:fs/promises";
import { vi } from "vitest";

import type { CacheHandler } from "../src/types.js";

/** The five methods a Recorded call can name. */
export type HandlerMethod = keyof CacheHandler;

/**
 * One Cache Handler method invocation, as the Fixture's recording wrapper wrote it: which
 * Instance ran it, with what key and tags, and what came of it.
 *
 * `outcome` is the event the handler reported during the call — `hit`, `miss:absent`,
 * `miss:expired`, `stale`, `set`, `skip:too-large` — and `ok` or `error` for the methods
 * that report none. `size` is the bytes a `skip` event carries, and is absent from every
 * call whose event carries none. `seq` counts within one process, so it orders the calls of one
 * Instance and says nothing across two: the file's line order is the only shared order,
 * and no Scenario asserts on it.
 */
export interface RecordedCall {
  seq: number;
  at: number;
  instance: string;
  method: HandlerMethod;
  key: string;
  tags: string[];
  outcome: string;
  size?: number;
}

/**
 * The Recorded calls of one Scenario, sliced by offset: a step takes the offset the file
 * ends at, drives its requests, and reads back what was appended since. Byte offsets
 * rather than line counts, because both Instances append to the one file and a step
 * never has to know how much the other one wrote.
 */
export interface RecordedCalls {
  /** Where the file ends now: the offset the next step slices from. */
  end(): Promise<number>;
  /** Every call appended since `offset`, oldest first. */
  since(offset: number): Promise<RecordedCall[]>;
  /**
   * The calls appended since `offset`, once one of them matches — the way a step waits for
   * work Next.js does in the background, since no instant of the clock names when a
   * background write lands.
   */
  waitFor(offset: number, wanted: (call: RecordedCall) => boolean): Promise<RecordedCall[]>;
}

/** Read the Recorded calls of one Scenario from the file its Instances append to. */
export function recordedCalls(file: string): RecordedCalls {
  const bytes = async (): Promise<Buffer> => {
    try {
      return await readFile(file);
    } catch {
      return Buffer.alloc(0);
    }
  };
  const since = async (offset: number): Promise<RecordedCall[]> => {
    const appended = (await bytes()).subarray(offset).toString("utf-8");

    return appended
      .split("\n")
      .filter((line) => line.endsWith("}"))
      .map((line) => JSON.parse(line) as RecordedCall);
  };

  return {
    end: async () => (await bytes()).length,
    since,
    waitFor: async (offset, wanted) => {
      await vi.waitUntil(async () => (await since(offset)).some(wanted), {
        timeout: 20_000,
        interval: 50,
      });

      return since(offset);
    },
  };
}

/**
 * What a step asserts on: the set of `<method> <outcome>` pairs one Instance recorded,
 * order left out, since the order two cache scopes are read in is Next.js's business.
 */
export function outcomesOf(calls: RecordedCall[], instance: string): Set<string> {
  return new Set(
    calls
      .filter((call) => call.instance === instance)
      .map((call) => `${call.method} ${call.outcome}`),
  );
}
