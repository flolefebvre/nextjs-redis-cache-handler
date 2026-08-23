import path from "node:path";

import type { NextConfig } from "next";

const handlerPath = path.resolve(__dirname, "recording-handler.mjs");

const nextConfig: NextConfig = {
  cacheComponents: true,
  cacheHandlers: {
    default: handlerPath,
    remote: handlerPath,
  },
  cacheLife: {
    short: { stale: 30, revalidate: 60, expire: 300 },
  },
};

export default nextConfig;
