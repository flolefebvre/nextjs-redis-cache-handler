import path from "node:path";

import { handlerPath } from "@flefebvre/nextjs-redis-cache-handler";
import type { NextConfig } from "next";

/**
 * Which Handler slot module this build registers, and where its output lands. The harness
 * builds the Fixture twice — once with the recording wrapper every Recorded call comes
 * from, once with the library's Zero-config entry and nothing of the harness in the path —
 * and starts each Instance with the same variable, so `next start` serves the build it was
 * started for. The two `distDir`s are what let both builds sit there at once.
 *
 * The Zero-config build registers the entry through both documented forms: `handlerPath`,
 * the absolute path the `.` entry exports, and `require.resolve` of the `./handler`
 * subpath. Both name the same file.
 */
const zeroConfig = process.env.NEXT_CACHE_E2E_HANDLER === "zero-config";
const recordingHandler = path.resolve(__dirname, "recording-handler.mjs");

const nextConfig: NextConfig = {
  cacheComponents: true,
  distDir: zeroConfig ? ".next-zero-config" : ".next",
  cacheHandlers: zeroConfig
    ? {
        default: handlerPath,
        remote: require.resolve("@flefebvre/nextjs-redis-cache-handler/handler"),
      }
    : { default: recordingHandler, remote: recordingHandler },
  cacheLife: {
    short: { stale: 30, revalidate: 60, expire: 300 },
  },
};

export default nextConfig;
