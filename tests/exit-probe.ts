import { createRedisCacheHandler } from "../src/index.js";

const url = process.env.CACHE_PROBE_REDIS_URL;
const keyPrefix = process.env.CACHE_PROBE_KEY_PREFIX;

if (url === undefined || keyPrefix === undefined) {
  throw new Error("CACHE_PROBE_REDIS_URL and CACHE_PROBE_KEY_PREFIX are required");
}

const handler = createRedisCacheHandler({ url, keyPrefix });

await handler.set(
  "probe",
  Promise.resolve({
    value: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Uint8Array.from([1, 2, 3]));
        controller.close();
      },
    }),
    tags: [],
    stale: 30,
    timestamp: Date.now(),
    expire: 60,
    revalidate: 30,
  }),
);

await handler.refreshTags();

if ((await handler.get("probe", [])) === undefined) {
  throw new Error("the probe Entry did not come back");
}

await handler.close();
