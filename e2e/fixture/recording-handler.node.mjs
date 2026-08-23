import { appendFileSync } from "node:fs";

import { createRedisCacheHandler, optionsFromEnv } from "@flefebvre/nextjs-redis-cache-handler";

/**
 * The Node.js target of the Fixture's Handler slot module: the real handler, configured
 * from the environment through `optionsFromEnv`, with one Recorded call appended to a
 * JSONL file per method invocation.
 *
 * Two variables the e2e harness sets, next to the library's own `REDIS_URL` and
 * `NEXT_REDIS_CACHE_*` table, which this module never parses itself:
 *
 * - `NEXT_CACHE_E2E_RECORD_FILE` → the JSONL file every Instance of the run appends to
 * - `NEXT_CACHE_E2E_INSTANCE` → the name this process is recorded under (`A`, `B`, `build`)
 *
 * One line per Recorded call: `{ seq, at, instance, method, key, tags, outcome }`. The
 * outcome of a `get` or a `set` is the event the handler reported during that call —
 * `hit`, `miss:expired`, `stale`, `set`, `skip:too-large` — and `ok` or `error` for the
 * methods that report none. A line is appended with one `appendFileSync`, so the two
 * Instances writing to one file never interleave a line.
 *
 * A missing variable, and an environment that configures no store, are harness errors and
 * throw at module load: an Instance that silently cached nothing would turn every
 * assertion of a Scenario into a puzzle.
 */
const recordFile = required("NEXT_CACHE_E2E_RECORD_FILE");
const instance = required("NEXT_CACHE_E2E_INSTANCE");
const options = optionsFromEnv(process.env);
if (options === undefined) {
  throw new Error("the Fixture app needs REDIS_URL: the e2e harness must set it");
}

const events = [];
const handler = createRedisCacheHandler({
  ...options,
  onEvent: (event) => events.push(event),
});
let seq = 0;

const recording = {
  async get(cacheKey, softTags) {
    const from = events.length;
    try {
      const entry = await handler.get(cacheKey, softTags);
      record("get", cacheKey, softTags, outcomeSince(from, cacheKey));

      return entry;
    } catch (error) {
      record("get", cacheKey, softTags, "error");
      throw error;
    }
  },

  async set(cacheKey, pendingEntry) {
    const from = events.length;
    let tags = [];
    const tracked = pendingEntry.then((entry) => {
      tags = entry.tags;

      return entry;
    });
    try {
      await handler.set(cacheKey, tracked);
      record("set", cacheKey, tags, outcomeSince(from, cacheKey));
    } catch (error) {
      record("set", cacheKey, tags, "error");
      throw error;
    }
  },

  async refreshTags() {
    try {
      await handler.refreshTags();
      record("refreshTags", "", [], "ok");
    } catch (error) {
      record("refreshTags", "", [], "error");
      throw error;
    }
  },

  async getExpiration(tags) {
    try {
      const expiration = await handler.getExpiration(tags);
      record("getExpiration", "", tags, "ok");

      return expiration;
    } catch (error) {
      record("getExpiration", "", tags, "error");
      throw error;
    }
  },

  async updateTags(tags, durations) {
    try {
      await handler.updateTags(tags, durations);
      record("updateTags", "", tags, "ok");
    } catch (error) {
      record("updateTags", "", tags, "error");
      throw error;
    }
  },
};

function required(variable) {
  const value = process.env[variable];
  if (value === undefined || value === "") {
    throw new Error(`the Fixture app needs \`${variable}\`: the e2e harness must set it`);
  }

  return value;
}

function outcomeSince(from, cacheKey) {
  const reported = events.slice(from).filter((event) => event.key === cacheKey);
  const event = reported[reported.length - 1];
  if (event === undefined) return "none";

  return "reason" in event ? `${event.type}:${event.reason}` : event.type;
}

function record(method, key, tags, outcome) {
  seq += 1;
  appendFileSync(
    recordFile,
    `${JSON.stringify({ seq, at: Date.now(), instance, method, key, tags: [...tags], outcome })}\n`,
  );
}

export default recording;
