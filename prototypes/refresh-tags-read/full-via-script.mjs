// PROTOTYPE: post-reconnect path = watermark read from 0 (everything). Expects a seeded manifest (run measure first with SIZES=100000).
import { connect, readSince, pct } from './lib.mjs';
const c = await connect(); const lat = []; let n = 0;
for (let i = 0; i < 10; i++) { const t = performance.now(); n = (await readSince(c, 0)).tags.length; lat.push(performance.now() - t); }
console.log(`readSince(0) over ${n} tags: p50 ${pct(lat, 50).toFixed(1)}ms max ${pct(lat, 100).toFixed(1)}ms`);
await c.quit();
