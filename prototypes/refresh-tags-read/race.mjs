// PROTOTYPE (throwaway): does a watermark reader ever miss a tag event?
// Three timestamp sources: (1) client Date.now() with clock skew, (2) server TIME fetched
// then ZADD in a second round trip, (3) server TIME inside one Lua script (atomic).
import { connect, H, LOG, readSince, writeTags } from './lib.mjs';

const reader = await connect();
const writers = await Promise.all([connect(), connect(), connect(), connect()]);

async function scenario(name, write) {
  await reader.del([H, LOG]);
  let { now: watermark } = await readSince(reader, Number.MAX_SAFE_INTEGER);
  const seen = new Map(); let boundaryRereads = 0; let reads = 0;
  let stop = false;
  const poll = (async () => {
    while (!stop) {
      const r = await readSince(reader, watermark); reads++;
      r.tags.forEach((t, i) => { if (seen.has(t) && seen.get(t) === r.values[i]) boundaryRereads++; seen.set(t, r.values[i]); });
      watermark = r.now;
    }
  })();
  // 4 writers, 500 rounds each, 2 tags per write, all hammering concurrently -> many same-ms writes
  await Promise.all(writers.map((w, wi) => (async () => {
    for (let i = 0; i < 500; i++) await write(w, wi, [`w${wi}:tag${i}`, `shared:${i}`]);
  })()));
  await new Promise(r => setTimeout(r, 50));
  stop = true; await poll; await readSince(reader, watermark).then(r => r.tags.forEach((t, i) => seen.set(t, r.values[i])));
  const truth = await reader.hGetAll(H);
  const missing = Object.keys(truth).filter(t => !seen.has(t));
  const staleLocal = Object.entries(truth).filter(([t, v]) => seen.has(t) && seen.get(t) !== v);
  const scores = await reader.zRangeWithScores(LOG, 0, -1);
  const distinctMs = new Set(scores.map(s => s.score)).size;
  console.log(`${name}\n  truth ${Object.keys(truth).length} tags over ${distinctMs} distinct ms; reader did ${reads} reads, ${boundaryRereads} boundary re-reads`);
  console.log(`  MISSED ${missing.length}${missing.length ? ' e.g. ' + missing.slice(0, 3).join(', ') : ''}; local value behind truth: ${staleLocal.length}`);
}

// (1) client clock, writer 0 skewed -40ms (as two instances with drifting clocks would be)
await scenario('(1) client Date.now() as timestamp, one writer 40ms behind', async (c, wi, tags) => {
  const now = Date.now() - (wi === 0 ? 40 : 0);
  const m = c.multi(); for (const t of tags) { m.hSet(H, t, `${now}:${now}`); m.zAdd(LOG, { score: now, value: t }); } await m.exec();
});
// (2) server TIME, then write in a second round trip (not atomic)
await scenario('(2) server TIME, ZADD in a second round trip', async (c, wi, tags) => {
  const [s, us] = (await c.sendCommand(['TIME']));
  const now = Number(s) * 1000 + Math.floor(Number(us) / 1000);
  if (wi === 0) await new Promise(r => setTimeout(r, 3)); // a GC pause / slow event loop on one instance
  const m = c.multi(); for (const t of tags) { m.hSet(H, t, `${now}:${now}`); m.zAdd(LOG, { score: now, value: t }); } await m.exec();
});
// (3) server TIME inside one script
await scenario('(3) server TIME inside one Lua script (atomic)', (c, wi, tags) => writeTags(c, tags, null));

await Promise.all([reader.quit(), ...writers.map(w => w.quit())]);
