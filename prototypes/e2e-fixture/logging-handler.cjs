// PROTOTYPE (throwaway). A cacheHandlers handler that stores Entries and the tag
// manifest in a shared directory so two `next start` processes see each other,
// and appends one JSON line per handler call to a per-process log.
// Not Redis: the point is to observe Next.js, not to test a store.
const fs = require('node:fs')
const path = require('node:path')

const STORE = path.join(__dirname, '.fixture-store')
const ENTRIES = path.join(STORE, 'entries')
const MANIFEST = path.join(STORE, 'tag-manifest.json')
fs.mkdirSync(ENTRIES, { recursive: true })
const port = process.env.PORT || 'build'
const LOG = path.join(STORE, `log-${port}-${process.pid}.jsonl`)
let seq = 0

function log(op, fields) {
  seq += 1
  fs.appendFileSync(
    LOG,
    JSON.stringify({ seq, t: Date.now(), pid: process.pid, port, phase: process.env.NEXT_PHASE, op, ...fields }) + '\n',
  )
}

function keyFile(key) {
  return path.join(ENTRIES, Buffer.from(key).toString('base64url') + '.json')
}
function readManifest() {
  try {
    return JSON.parse(fs.readFileSync(MANIFEST, 'utf8'))
  } catch {
    return {}
  }
}
function writeManifest(m) {
  fs.writeFileSync(MANIFEST, JSON.stringify(m))
}

let localManifest = readManifest()
const pendingSets = new Map()

async function bufferStream(stream) {
  const chunks = []
  const reader = stream.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
  }
  return Buffer.concat(chunks)
}

function isExpiredByTags(entry, tags, now) {
  for (const tag of tags) {
    const rec = localManifest[tag]
    if (rec && rec.expiredAt !== undefined && rec.expiredAt >= entry.timestamp && rec.expiredAt <= now) return true
  }
  return false
}
function isStaleByTags(entry, tags, now) {
  for (const tag of tags) {
    const rec = localManifest[tag]
    if (rec && rec.staleAt !== undefined && rec.staleAt >= entry.timestamp && rec.staleAt <= now) return true
  }
  return false
}

const handler = {
  async get(cacheKey, softTags) {
    const pending = pendingSets.get(cacheKey)
    if (pending) await pending
    const file = keyFile(cacheKey)
    let stored
    try {
      stored = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {
      log('get', { key: cacheKey, softTags, result: 'miss' })
      return undefined
    }
    const now = Date.now()
    const value = Buffer.from(stored.value, 'base64')
    const entry = { ...stored.meta, value: null }
    if (entry.timestamp + entry.expire * 1000 <= now) {
      log('get', { key: cacheKey, softTags, result: 'expired-ttl' })
      return undefined
    }
    if (isExpiredByTags(entry, entry.tags, now) || isExpiredByTags(entry, softTags, now)) {
      log('get', { key: cacheKey, softTags, result: 'expired-tag' })
      return undefined
    }
    const stale = isStaleByTags(entry, entry.tags, now) || entry.timestamp + entry.revalidate * 1000 <= now
    log('get', {
      key: cacheKey,
      softTags,
      result: stale ? 'hit-stale' : 'hit',
      size: value.length,
      tags: entry.tags,
      age: now - entry.timestamp,
    })
    return {
      ...entry,
      revalidate: stale ? -1 : entry.revalidate,
      value: new ReadableStream({
        start(c) {
          c.enqueue(new Uint8Array(value))
          c.close()
        },
      }),
    }
  },

  async set(cacheKey, pendingEntry) {
    let resolve
    const p = new Promise((r) => (resolve = r))
    pendingSets.set(cacheKey, p)
    try {
      const entry = await pendingEntry
      const value = await bufferStream(entry.value)
      const meta = {
        tags: entry.tags,
        stale: entry.stale,
        timestamp: entry.timestamp,
        expire: entry.expire,
        revalidate: entry.revalidate,
      }
      fs.writeFileSync(keyFile(cacheKey), JSON.stringify({ meta, value: value.toString('base64') }))
      log('set', { key: cacheKey, size: value.length, ...meta })
    } catch (err) {
      log('set', { key: cacheKey, error: String(err) })
    } finally {
      pendingSets.delete(cacheKey)
      resolve()
    }
  },

  async refreshTags() {
    localManifest = readManifest()
    log('refreshTags', { tagsInManifest: Object.keys(localManifest).length })
  },

  async getExpiration(tags) {
    let latest = 0
    const now = Date.now()
    for (const tag of tags) {
      const rec = localManifest[tag]
      if (rec && rec.expiredAt !== undefined && rec.expiredAt <= now) latest = Math.max(latest, rec.expiredAt)
    }
    log('getExpiration', { tags, result: latest })
    return latest
  },

  async updateTags(tags, durations) {
    const now = Date.now()
    const m = readManifest()
    for (const tag of tags) {
      const rec = m[tag] || {}
      if (durations === undefined) {
        rec.expiredAt = now
      } else {
        rec.staleAt = now
        rec.expiredAt = now + (durations.expire ?? 0) * 1000
      }
      m[tag] = rec
    }
    writeManifest(m)
    localManifest = m
    log('updateTags', { tags, durations: durations ?? null })
  },
}

module.exports = handler
