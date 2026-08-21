// PROTOTYPE (throwaway): per-request cost of refreshTags as (a) full HGETALL vs (b) watermark read.
import { connect, H, LOG, tagName, pct, writeTags, readSince } from './lib.mjs';

const SIZES = (process.env.SIZES ?? '100,10000,100000').split(',').map(Number);
const CHURNS = [0, 10, 1000]; // events since last read
const ITER = Number(process.env.ITER ?? 30);

const client = await connect();
const ver = (await client.info('server')).match(/(?:valkey|redis)_version:(\S+)/g);
console.log(`server: ${ver.join(' ')}\n`);

async function outputBytes() {
  const m = (await client.info('stats')).match(/total_net_output_bytes:(\d+)/);
  return Number(m[1]);
}
async function measureBytes(fn) {
  const a = await outputBytes(); const b = await outputBytes(); const infoCost = b - a;
  const c = await outputBytes(); await fn(); const d = await outputBytes();
  return d - c - infoCost;
}
async function timeIt(fn) {
  const lat = [];
  for (let i = 0; i < ITER; i++) { const t = performance.now(); await fn(); lat.push(performance.now() - t); }
  return `p50 ${pct(lat, 50).toFixed(2)}ms  p95 ${pct(lat, 95).toFixed(2)}ms  max ${pct(lat, 100).toFixed(2)}ms`;
}
function heapOf(build) {
  global.gc(); const before = process.memoryUsage().heapUsed;
  const keep = build(); global.gc(); const after = process.memoryUsage().heapUsed;
  return { bytes: after - before, keep };
}
const kb = (n) => `${(n / 1024).toFixed(1)} KiB`;

for (const N of SIZES) {
  console.log(`=== ${N} revalidated tags ===`);
  await client.del([H, LOG]);
  // seed in batches; all "old" events
  for (let i = 0; i < N; i += 1000) {
    const batch = []; for (let j = i; j < Math.min(N, i + 1000); j++) batch.push(tagName(j));
    await writeTags(client, batch, null);
  }
  const memH = await client.memoryUsage(H); const memLog = await client.memoryUsage(LOG);
  console.log(`redis memory: hash ${kb(memH)}, log zset ${kb(memLog)}, total ${kb(memH + memLog)}`);

  // (a) full read
  const full = await client.hGetAll(H);
  const fullBytes = await measureBytes(() => client.hGetAll(H));
  const { bytes: heapFull } = heapOf(() => {
    const m = new Map(); for (const [tag, v] of Object.entries(full)) { const [s, e] = v.split(':'); m.set(tag, { stale: +s, expired: +e }); } return m;
  });
  console.log(`(a) HGETALL full read: ${await timeIt(() => client.hGetAll(H))}  payload ${kb(fullBytes)}  local Map heap ${kb(heapFull)}`);

  // (b) watermark read with k events since the watermark
  for (const k of CHURNS) {
    const { now } = await readSince(client, Number.MAX_SAFE_INTEGER); // fresh watermark = now
    await new Promise(r => setTimeout(r, 2));
    if (k > 0) { const tags = []; for (let j = 0; j < k; j++) tags.push(tagName(j)); await writeTags(client, tags, 3600); }
    const res = await readSince(client, now);
    const bytes = await measureBytes(() => readSince(client, now));
    console.log(`(b) watermark read, ${String(k).padStart(4)} new events: ${await timeIt(() => readSince(client, now))}  payload ${kb(bytes)}  returned ${res.tags.length} tags`);
  }
  console.log();
}
await client.quit();
