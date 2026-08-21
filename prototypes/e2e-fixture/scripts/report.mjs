// PROTOTYPE report: merges per-process logs + markers by time and prints the
// call sequence per step, then an entry-size table.
import fs from 'node:fs'
import path from 'node:path'
const STORE = path.resolve(import.meta.dirname, '../.fixture-store')
const lines = []
for (const f of fs.readdirSync(STORE)) {
  if (!f.endsWith('.jsonl')) continue
  for (const l of fs.readFileSync(path.join(STORE, f), 'utf8').split('\n')) if (l) lines.push(JSON.parse(l))
}
lines.sort((a, b) => a.t - b.t || (a.seq ?? 0) - (b.seq ?? 0))
const short = (k) => {
  try {
    const a = JSON.parse(k)
    return `${a[1].slice(0, 8)}…(${a.length - 2} args)`
  } catch {
    return k.slice(0, 30)
  }
}
for (const l of lines) {
  if (l.op === 'MARK') {
    console.log(`\n== ${l.step}`)
    continue
  }
  const who = l.port === 'build' ? `build:${l.pid}` : `:${l.port}`
  let d = ''
  if (l.op === 'get') d = `${l.result}${l.size ? ` ${l.size}B` : ''} key=${short(l.key)} soft=${JSON.stringify(l.softTags)}${l.tags ? ` tags=${JSON.stringify(l.tags)}` : ''}`
  if (l.op === 'set') d = l.error ? `ERROR ${l.error}` : `${l.size}B key=${short(l.key)} tags=${JSON.stringify(l.tags)} stale=${l.stale} revalidate=${l.revalidate} expire=${l.expire}`
  if (l.op === 'updateTags') d = `tags=${JSON.stringify(l.tags)} durations=${JSON.stringify(l.durations)}`
  if (l.op === 'getExpiration') d = `tags=${JSON.stringify(l.tags)} -> ${l.result}`
  if (l.op === 'refreshTags') d = `(${l.tagsInManifest} tags)`
  console.log(`  ${who.padEnd(11)} ${l.op.padEnd(14)} ${d}`)
}
console.log('\n== Entry sizes (from set calls; bytes of RSC payload)')
const sizes = new Map()
for (const l of lines) if (l.op === 'set' && l.size) sizes.set(JSON.stringify(l.tags) + ' ' + short(l.key), l.size)
for (const [k, v] of [...sizes].sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(8)}B  ${k}`)
