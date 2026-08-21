import type { NextConfig } from 'next'
import path from 'node:path'

const nextConfig: NextConfig = {
  cacheComponents: true,
  cacheHandlers: {
    default: path.resolve(__dirname, 'logging-handler.cjs'),
  },
  cacheLife: {
    short: { stale: 30, revalidate: 60, expire: 300 },
  },
}

export default nextConfig
