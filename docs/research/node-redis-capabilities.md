# node-redis 6 capabilities the handler relies on

Research for issue #4 (part of #1). Date: 2026-08-21.

Versions examined:

- `redis@6.2.1` / `@redis/client@6.2.1` (installed with `npm i redis@6`; source read from `node_modules/@redis/client/dist/lib/`, referred to below as `lib/`).
- Servers probed with the scripts in the appendix: Redis 8.10.1 (`redis:8`), Valkey 9.1.1 (`valkey/valkey:9`), Valkey 8.1.9 (`valkey/valkey:8`), Valkey 7.2.14 (`valkey/valkey:7.2`). Every Valkey build also reports `redis_version:7.2.4` in `INFO server`, so do not rely on `redis_version` to detect Valkey features.

## Summary for the handler design

**Client construction**

```ts
import { createClient, RESP_TYPES } from 'redis';

const client = createClient({
  url,
  disableOfflineQueue: true,               // fail fast while disconnected (ClientOfflineError)
  pingInterval: 10_000,                    // MUST be < socketTimeout, see (5)
  socket: {
    connectTimeout: 2_000,
    socketTimeout: 30_000,                 // reply-side dead-connection detector
    reconnectStrategy: (retries, cause) => Math.min(50 * 2 ** retries, 2_000) + Math.random() * 200,
    //            ^ a custom function is REQUIRED: the default returns `false` (client closes forever)
    //              when the cause is SocketTimeoutError.
  },
});
client.on('error', () => {});             // mandatory or the process crashes
const bin = client.withTypeMapping({ [RESP_TYPES.BLOB_STRING]: Buffer }); // proxy sharing the same socket
```

**Concrete calls**

| Need | Call | Notes |
|---|---|---|
| Write hash with one `Buffer` field + string fields, atomically | `client.hSet(key, { body: buf, ct: 'text/html', ts: 123 })` | one `HSET key f v f v ...`; numbers are stringified, `Buffer` passed through untouched (`lib/commands/HSET.js`). The multi-field form `HSET key field value [field value ...]` is the documented syntax ([redis.io HSET](https://redis.io/docs/latest/commands/hset/)) and worked on every server probed. |
| Read it back with `Buffer` values | `bin.hGetAll(key)` / `bin.hmGet(key, ['body','ct'])` / `bin.hGet(key,'body')` | `hGetAll` keys stay JS strings, every value is a `Buffer`; a missing key yields `{}` / `null`. Without the mapping, invalid UTF-8 is lossily decoded (7 bytes became 15). |
| Hash + TTL in one atomic unit, portable | `client.multi().hSet(key, obj).expire(key, ttlSec).exec()` | returns `[fieldsAdded, 1]`; works on Valkey 7.2 / 8 / 9 and Redis 8. MULTI/EXEC is sent as one chain and never split across reconnects. |
| Hash + TTL in one command (optional fast path) | `client.hSetEx(key, obj, { expiration: { type: 'EX', value: ttl } })` | **field** TTLs, not a key TTL (`TTL key` = -1). Redis >= 8.0, Valkey >= 9.0; **absent on Valkey 8.x** (`ERR unknown command 'HSETEX'` on 8.1.9). Any later `HSET`/`HSETEX` on a field wipes that field's TTL. |
| Server clock | `client.time()` -> `[secondsStr, microsStr]` (strings) | fine inside `multi()`/`execAsPipeline()`; all `TIME`s in one `EXEC` return the identical value. With the `Buffer` proxy you get Buffers, so call it on the string client. |
| Tag manifest (watermark) | `client.zAdd(tag, [{ score, value }], { comparison: 'GT', CH: true })` then `client.zRangeWithScores(tag, min, max, { BY: 'SCORE', LIMIT })` | `ZRANGE ... BYSCORE` needs Redis >= 6.2 (`zRangeByScoreWithScores` also works but `ZRANGEBYSCORE` is deprecated since 6.2). Scores are doubles: exact to 2^53, so millisecond and microsecond epochs are safe. `ZSCORE` of a missing member is `null`. |
| Per-call latency budget | `Promise.race([call, deadline])` or `AbortSignal.timeout()` at the handler level | `commandOptions.timeout` and `abortSignal` **only** reject while the command is still queued; once written to the socket they are removed, so a stalled server never triggers them (verified: all hung until the server was unpaused). A raced-out command still executes on the server later; for a cache that is acceptable. |
| "Did a reconnect happen since my last call?" | count `'reconnecting'` events, or compare `client.socketEpoch` | `socketEpoch` increments right before `'ready'` (`lib/client/socket.js`); offline-queued commands can resolve **before** that (they are written together with the handshake), so the `'reconnecting'` event is the earlier, safer signal. |

**Minimum server versions**

- Core design (RESP3 `HELLO`, multi-field `HSET`, `MULTI`/`EXPIRE`, `TIME`, `ZADD GT/CH`, `ZRANGE BYSCORE`): **Redis 6.2**, **Valkey 7.2** (earliest Valkey). node-redis 6 sends `HELLO 3` by default (Redis >= 6.0); pass `RESP: 2` for older servers.
- Optional hash-field-TTL path: `HEXPIRE`/`HTTL` Redis **7.4**, `HSETEX`/`HGETEX` Redis **8.0**; all of them Valkey **9.0** (not 8.x). Feature-detect with `COMMAND INFO HSETEX` or catch `ERR unknown command`.

**Gotchas, ranked**

1. Default `reconnectStrategy` gives up (closes the client, every later call rejects `ClientClosedError`) when the cause is `SocketTimeoutError`. Always supply your own function if you set `socketTimeout`.
2. `socketTimeout` is an *inactivity* timer: an idle healthy connection is destroyed after `socketTimeout` ms with no traffic (verified: 1 s idle -> `SocketTimeoutError`, client closed). Set `pingInterval` below it.
3. `commandOptions.timeout` / `abortSignal` do not cover the in-flight phase (see table). Put the deadline around the await.
4. With the offline queue enabled (default) commands issued while disconnected wait for the reconnect (bounded only by `commandOptions.timeout`); in-flight commands at the moment of the drop are rejected with `SocketClosedUnexpectedlyError`, never retried. With `disableOfflineQueue: true` you get `ClientOfflineError` immediately, and the drop also rejects anything still queued.
5. `withTypeMapping` / `withCommandOptions` return lightweight proxies over the same connection; `multi()` created from the proxy applies the mapping to the transaction replies. Use one Buffer proxy for bodies and the plain client for metadata/`TIME`.
6. Error replies inside `MULTI` surface as `MultiErrorReply` (`.replies`, `.errorIndexes`) after `exec()`; `exec()` returning `null` (WATCH conflict) throws `WatchError`.

---

## (1) Hash with a binary field plus string fields; reading the value back as a `Buffer`

**Writing.** `HSET` accepts `string | number | Buffer` for the single-field form and an object / `Map` / tuple array for multi-field writes; every value goes through `convertValue`, which only stringifies numbers and passes `Buffer`s through (`lib/commands/HSET.js`). `RedisArgument = string | Buffer` is the wire type (`lib/RESP/types.d.ts`). One `HSET key f1 v1 f2 v2 ...` is a single command, therefore atomic.

Probe (all four servers):

```
HSET k {body:<Buffer>, ct:string, ts:number} -> 3
```

**Reading.** Type mapping is the documented mechanism for binary replies: "Demonstrates how to override the default type mapping for BLOB_STRING to Buffer using `withTypeMapping` ... to prevent lossy decoding" (node-redis `docs/command-options.md`, fetched via ctx7 `/redis/node-redis`). Three equivalent ways:

- client-wide: `createClient({ commandOptions: { typeMapping: { [RESP_TYPES.BLOB_STRING]: Buffer } } })`
- proxy: `client.withTypeMapping({ [RESP_TYPES.BLOB_STRING]: Buffer })`
- per call: `client.withCommandOptions({ typeMapping: {...} }).hmGet(...)`

`withCommandOptions` creates `Object.create(this._self)` with the merged options (`lib/client/index.js` around line 705), so proxies are cheap and share the socket and queue. The mapping is stored per queued command and handed to the decoder when that reply arrives (`lib/client/commands-queue.js`, `#getTypeMapping`).

The RESP3 `HGETALL` reply is a map; the type system forces map *keys* to strings even under a Buffer mapping (`MapKey` in `lib/RESP/types.d.ts` overrides `BLOB_STRING`/`SIMPLE_STRING` to `String` for keys) and the probe confirms it.

Probe (all four servers, `bin = 00 ff fe 80 01 c3 28`, deliberately invalid UTF-8):

```
HGETALL (string client) -> {"body":" ...(","ct":"text/html","ts":"123"}
  string-decoded body equals original? false  decoded length 15 vs 7
HGETALL (Buffer client) -> {"body":"<Buffer 00fffe8001c328>","ct":"<Buffer 746578742f68746d6c>","ts":"<Buffer 313233>"}
  Buffer body isBuffer? true equals original? true ct isBuffer? true keys: ["body","ct","ts"]
HMGET body ct (Buffer client) -> [<Buffer 00fffe8001c328>, <Buffer 746578742f68746d6c>]   hmGet body equals? true
HMGET with per-call typeMapping -> ... per-call mapping body isBuffer? true
HGET body (Buffer client) -> <Buffer 00fffe8001c328>   equals? true
HGET missing (Buffer client) -> null
HGETALL missing key (Buffer client) -> {}
```

So: decoding binary as a string is lossy (as the docs warn); with the mapping every value in the hash comes back as a `Buffer`, including the string metadata fields, which the handler must `.toString()` (or read metadata with the plain client via `hmGet`, which costs an extra round trip, or keep the hash small and convert).

**RESP version.** `DEFAULT_RESP = 3` (`lib/RESP/types.d.ts`); the handshake sends `HELLO 3` unless `RESP: 2` is configured (`lib/client/index.js` `#getHandshakeCommands`). HGETALL's reply transformer differs by protocol (`transformTuplesReply` under RESP2, raw map under RESP3; `lib/commands/HGETALL.js`) but the object shape delivered to the caller is the same.

## (2) TTL in the same atomic unit

### Option A: `MULTI` + `EXPIRE` (portable)

`client.multi().hSet(key, obj).expire(key, seconds).exec()` queues `MULTI`, the commands and `EXEC` on one `chainId` and writes them together (`lib/client/index.js` `_executeMulti`). The queue treats a chain as indivisible: if the connection drops mid-chain the queued tail is rejected rather than resent on the new socket (`flushWaitingForReply` in `lib/client/commands-queue.js`; comments on `extractCommandsForSlots`). Replies are transformed with the proxy's type mapping (`lib/multi-command.js` `transformReplies`). Error replies are collected into `MultiErrorReply` (`lib/errors.js`).

Probe (all four servers):

```
MULTI hSet+expire EXEC -> [2,1]          TTL k2 -> 100
MULTI hSet+pExpire EXEC (typed) -> [1,1]
MULTI with Buffer client: hSet + hGetAll + expire -> [1,{"body":<bytes>},1]
ZADD+EXPIRE in MULTI -> [1,1]
```

### Option B: `HSETEX` (field-level TTL, newer servers)

- node-redis signature: `hSetEx(key, fields, { expiration?: { type: 'EX'|'PX'|'EXAT'|'PXAT', value } | 'KEEPTTL', mode?: 'FNX'|'FXX' })`, reply `0 | 1` (`lib/commands/HSETEX.d.ts`, `HSETEX.js`). It emits `HSETEX key [FNX|FXX] [EX n|...] FIELDS <count> f v ...`.
- Redis docs: `HSETEX` "since 8.0.0", "Set the value of one or more fields of a given hash key, and optionally set their expiration" ([redis.io HSETEX](https://redis.io/docs/latest/commands/hsetex/)). `HEXPIRE` "since 7.4.0" ([redis.io HEXPIRE](https://redis.io/docs/latest/commands/hexpire/)); `HGETEX` "since 8.0.0" ([redis.io HGETEX](https://redis.io/docs/latest/commands/hgetex/)).
- Valkey docs: `HSETEX` "Since 9.0.0" with the extended syntax `HSETEX key [NX|XX] [FNX|FXX] [EX ...] FIELDS ...` ([valkey.io HSETEX](https://valkey.io/commands/hsetex/)); `HEXPIRE` "Since 9.0.0" ([valkey.io HEXPIRE](https://valkey.io/commands/hexpire/)). The 9.0.0-rc1 release notes (2025-08-14) list "hash field expiration" among the headline features (`gh api repos/valkey-io/valkey/releases/tags/9.0.0-rc1`); 9.0.0 GA is dated 2025-10-21.
- Semantics that matter for a cache entry: field TTLs are independent of the key TTL (`TTL key` stays -1), and "Field expirations will only be cleared by commands that delete or overwrite the contents of the hash fields, including HDEL and HSET" (redis.io HEXPIRE). The probe confirms that a later `HSETEX` without an expiration, or a plain `HSET`, resets the field TTL to -1.

Probe:

```
Redis 8.10.1 / Valkey 9.1.1:
  HSETEX k3 EX 100 FIELDS {body,ct} -> 1     HTTL k3 body ct -> [100,100]     TTL k3 (key-level) -> -1
  HSETEX again without expiration -> 1       HTTL k3 ct -> [-1]
  HSET over k3 body -> 0                     HTTL k3 body -> [-1]
  HEXPIRE k 100 FIELDS body -> [1]           HTTL k body -> [100]
  raw HSETEX FNX EX 10 -> 1                  HGETEX k5 PERSIST FIELDS a -> ["b"]
  raw HSETEX with NX  -> Redis: ERR unknown argument: NX     Valkey 9: 1
Valkey 8.1.9 / Valkey 7.2.14:
  HSETEX / HEXPIRE / HTTL / HGETEX -> ERR unknown command
```

**Recommendation.** Use `MULTI hSet + expire` (or `pExpire`) as the one path; it is atomic, portable back to Valkey 7.2, and gives a key-level TTL so the whole entry disappears together. `HSETEX` saves one round trip but is Redis 8 / Valkey 9 only, and its per-field TTL is silently dropped by any later `HSET` on the field (for example a metadata touch), which is a footgun for a cache entry.

## (3) `TIME`, standalone and inside a pipeline / `MULTI`

- Redis docs: `TIME` "since 2.6.0", returns "a two-element array consisting of the Unix timestamp in seconds and the microseconds' count" ([redis.io TIME](https://redis.io/docs/latest/commands/time/)).
- node-redis types it as `[unixTimestamp: BlobStringReply, microseconds: BlobStringReply]` (`lib/commands/TIME.d.ts`) and flags it `IS_READ_ONLY` (`TIME.js`); there is no numeric transform, so the caller parses.

Probe (all four servers):

```
TIME -> ["1787325433","671557"]    typeof elements: string string
MULTI time + hSet + time EXEC -> [["1787325433","672462"],1,["1787325433","672462"]]
pipeline (execAsPipeline) time + get -> [["1787325433","673592"],null]
TIME via Buffer client -> [<Buffer 3137...>, <Buffer 3637...>]
TIME via sendCommand -> ["1787325433","674891"]
```

Observations: `TIME` is allowed inside `MULTI` and inside a non-atomic pipeline (`execAsPipeline`, which writes all commands with one `chainId` and no `MULTI`/`EXEC`, `lib/client/index.js` `_executePipeline`). Inside one `EXEC` every `TIME` returns the same instant, so `multi().time().hSet(...).exec()` yields the exact server timestamp at which the write happened. Under the Buffer proxy the two elements are `Buffer`s; use the plain client or `.toString()`.

## (4) Sorted-set operations for a watermark tag manifest

- `zAdd(key, member | members[], { condition?: 'NX'|'XX', comparison?: 'LT'|'GT', CH?: boolean })` where a member is `{ score: number, value: RedisArgument }`; scores go through `transformDoubleArgument` (so `Infinity` becomes `+inf`) and the reply is a number (`lib/commands/ZADD.js`, `ZADD.d.ts`). Server support: `NX|XX|CH` since 3.0.2, `GT|LT` since 6.2.0 ([redis.io ZADD](https://redis.io/docs/latest/commands/zadd/)).
- `zRangeByScore(key, min, max, { LIMIT })` / `zRangeByScoreWithScores(...)` emit `ZRANGEBYSCORE ... [WITHSCORES]`; `min`/`max` accept numbers or strings such as `'-inf'`, `'(1500'` (`lib/commands/ZRANGEBYSCORE.js`). redis.io marks `ZRANGEBYSCORE` "Deprecated as of Redis v6.2.0" ([redis.io ZRANGEBYSCORE](https://redis.io/docs/latest/commands/zrangebyscore/)); the replacement is `zRangeWithScores(key, min, max, { BY: 'SCORE', REV?, LIMIT? })` (`lib/commands/ZRANGE.d.ts`). Both `WITHSCORES` variants return `Array<{ value, score: number }>` via `transformSortedSetReply`, which reads RESP3 doubles directly and parses RESP2 strings (`ZRANGEBYSCORE_WITHSCORES.d.ts`, `generic-transformers.js`).
- Score precision: "This format precisely represents integers between -(2^53) and +(2^53)" (redis.io ZADD).

Probe (all four servers):

```
ZADD tag:a [{score,value}x3] -> 3
ZADD GT CH update k1 -> 1500 -> 1          ZADD GT CH lower k1 -> 10 -> 0
ZRANGEBYSCORE -inf 2000.5 -> ["k1","k2"]
ZRANGEBYSCORE_WITHSCORES (1500 +inf -> [{"value":"k2","score":2000.5},{"value":"k3","score":3000}]
ZRANGE BYSCORE WITHSCORES -> [{"value":"k1","score":1500},{"value":"k2","score":2000.5},{"value":"k3","score":3000}]
ZRANGE BYSCORE REV LIMIT 0 1 -> [{"value":"k3","score":3000}]
ZSCORE k2 -> 2000.5     ZSCORE missing -> null
ZREMRANGEBYSCORE -inf (1500 -> 0
ZRANGEBYSCORE_WITHSCORES Buffer client -> values are Buffers, scores stay numbers
ZADD score = Date.now()*1000+123 -> [1787325433684123, 1787325433684123]   (round-trips exactly)
ZADD score = 2^53+1 -> [9007199254740992, 9007199254740992]                 (precision lost, as documented)
```

`comparison: 'GT'` with `CH: true` is the right primitive for a monotonically-advancing watermark: it updates only when the new score is greater and reports whether it changed. Microsecond epochs (about 1.8e15) are well inside the exact range.

## (5) Per-command timeouts

What the client offers (`lib/client/commands-queue.js` `addCommand`, `commandsToWrite`):

- `commandOptions.timeout` (client-wide or via `withCommandOptions({ timeout })`) creates `AbortSignal.timeout(ms)` and rejects with `TimeoutError`.
- `commandOptions.abortSignal` / `client.withAbortSignal(signal)` rejects with `AbortError`; an already-aborted signal rejects synchronously.
- Both listeners are **removed when the command is shifted off the write queue**: `if (toSend.timeout) { removeTimeoutListener(toSend); toSend.timeout = undefined; }` in `commandsToWrite()`. The docs say the same: "Commands exceeding this duration before being written to the socket will be timed out" and AbortSignal aborts "commands that have not yet been written to the socket" (node-redis `docs/command-options.md` via ctx7).

Probe (Redis 8.10.1, container paused with `docker pause` so the socket stays open but nothing is answered):

```
commandOptions.timeout=300 / abortSignal(300) / manual race: "STILL PENDING after 1500ms"
container unpaused
after unpause the three promises are: [{"ok":"PONG"},{"ok":"PONG"},{"err":"Error: manual deadline"}]
```

So neither option bounds the time a written command can hang. The only built-in reply-side protection is `socket.socketTimeout` ("The timeout (in milliseconds) after which the socket will be closed", `lib/client/socket.d.ts`), which destroys the socket with `SocketTimeoutError` and rejects every in-flight command. Two properties of it were verified:

```
## socketTimeout=500 while paused, default reconnectStrategy
error -> SocketTimeoutError ... didn't receive any in 500ms.
ping -> SocketTimeoutError   isOpen=false isReady=false
ping after socket timeout -> ClientClosedError: The client is closed

## socketTimeout=500 + custom reconnectStrategy returning a number
error -> SocketTimeoutError; reconnectStrategy(retries=0, cause=SocketTimeoutError); event: reconnecting
ping after unpause -> PONG

## idle but healthy connection, socketTimeout=1000, no traffic
[+1085ms] error -> SocketTimeoutError ... 1000ms.     after 2.5s idle: isOpen=false
## same with pingInterval=400
ping-interval x6 ... after 2.5s idle: isOpen=true isReady=true
```

Source for the first: `defaultReconnectStrategy(retries, cause) { if (cause instanceof SocketTimeoutError) return false; ... }` (`lib/client/socket.js`), and `false` means "do not reconnect, close the client and flush the command queue" (`socket.d.ts`). Source for the third: `socket.setTimeout(this.#socketTimeout)` in `#createSocket` is Node's inactivity timer; `pingInterval` sends `PING` every N ms while ready (`lib/client/index.js` `#setPingTimer`).

**Safe pattern for the handler**

1. Wrap each cache operation in your own deadline (`Promise.race` with a timer, or `AbortSignal.timeout` checked after the await) and treat a timeout as a cache miss. Accept that the command may still run on the server later; for `GET`-style reads that is harmless, and writes are idempotent.
2. Set `socket.socketTimeout` to a generous value (tens of seconds) purely to reap dead connections, together with `pingInterval` well below it and a custom `reconnectStrategy` that returns a delay for every cause (optionally giving up after N retries by returning an `Error`).
3. Set `disableOfflineQueue: true` so calls made while disconnected fail immediately with `ClientOfflineError` instead of piling up; or keep the queue and rely on `commandOptions.timeout`, which *does* bound queued time. `commandsQueueMaxLength` is a further cap (`Error('The queue is full')`).
4. `connectTimeout` (default 5000 ms, `socket.js` constructor) bounds the TCP/TLS connect only.

## (6) Reconnect behaviour, events, offline queue, detecting a reconnect

**Events** (README "Client Events" via ctx7, and `lib/client/socket.js`): `connect` (socket established, before handshake), `ready` (handshake done), `end` (socket destroyed by `destroy()`/`quit()`/close), `error` (must have a listener), `reconnecting`. Order on an unexpected drop (`#onSocketError`): `error` -> `reconnecting` -> (`connect` -> `ready`) or (`error` -> wait -> `reconnecting` -> ...) while `reconnectStrategy` keeps returning a number. `socketEpoch` is incremented immediately before `emit('ready')`.

**Default strategy** (`socket.js` `defaultReconnectStrategy`): `min(2^retries * 50, 2000) + jitter(0..200)` ms, except `false` for `SocketTimeoutError`. `reconnectStrategy` may return `number | false | Error`; returning an `Error` closes the client with `ReconnectStrategyError`.

**What happens to commands** (`lib/client/index.js` `#attachListeners` and `sendCommand`):

- In flight when the socket dies: always rejected (`flushWaitingForReply(err)`), `err` being `SocketClosedUnexpectedlyError` (or the socket error). Never retried.
- Queued but not yet written, offline queue enabled (default): kept, written as soon as the new socket's handshake is sent (`#initiateSocket` calls `this.#write()` inside the initiator, which drains the whole write queue), i.e. **before** `'ready'` and before `socketEpoch++`.
- Queued, `disableOfflineQueue: true`: `flushAll(err)` rejects them too, and any new call while `!isReady` rejects with `ClientOfflineError`; while `!isOpen` with `ClientClosedError`.

Probe (Redis 8.10.1, `CLIENT KILL` from a second connection):

```
## offline queue enabled
event: error -> SocketClosedUnexpectedlyError; event: reconnecting (isOpen=true isReady=false socketEpoch=1)
ping issued while isReady=false
in-flight BLPOP -> SocketClosedUnexpectedlyError
event: connect
queued PING -> PONG   socketEpoch 1 -> 1        <- resolved before 'ready' / before the epoch moved
## disableOfflineQueue: true
in-flight BLPOP -> SocketClosedUnexpectedlyError
immediate PING -> SocketClosedUnexpectedlyError  (issued in the same tick as the kill, flushed by flushAll)
event: connect; event: ready (socketEpoch=2); PING after ready -> PONG
## docker restart (server gone for ~1s)
ping issued after restart -> SocketClosedUnexpectedlyError (written to the dead socket, then flushed)
```

**Detecting "a reconnect happened since my last call"**

- `client.socketEpoch` (public getter, `lib/client/index.d.ts`) is the client's own notion: `_executeMulti` throws `WatchError('Client reconnected after WATCH')` when the epoch changed since `WATCH`. Snapshot it before a call and compare after; but note the ordering above: a call that was offline-queued can complete on the new socket while the epoch still shows the old value, so a pure epoch comparison can miss exactly the reconnect that affected your call.
- The `'reconnecting'` event fires synchronously on the disconnect path, before any command is re-sent. Maintaining `let generation = 0; client.on('reconnecting', () => generation++)` and comparing `generation` before/after an await is the reliable check. `'error'` fires one step earlier but also for non-connection errors (for example `reconnectStrategy` throwing, `pingInterval` failures).
- `client.isReady` / `client.isOpen` give the instantaneous state.
- Minor: a client that is mid-retry when `close()` is called can still emit a final `'reconnecting'` with `isOpen=false` (seen in the probe log); guard handlers with `client.isOpen` if that matters.

## (7) Minimum server versions implied

| Capability | Redis | Valkey | Source |
|---|---|---|---|
| RESP3 / `HELLO` (node-redis 6 default) | 6.0 | 7.2 (all Valkey) | `lib/client/index.js` `#getHandshakeCommands`; `RESP: 2` option in `RESP/types.d.ts` |
| Multi-field `HSET` | <= 6.2 (command since 2.0.0; multi-field syntax is the documented form) | 7.2 | https://redis.io/docs/latest/commands/hset/ ; probe on all four servers |
| `MULTI`/`EXEC`, `EXPIRE`, `PEXPIRE`, `TIME` | 2.6 | 7.2 | redis.io TIME "since 2.6.0" |
| `ZADD GT/LT` | 6.2 | 7.2 | redis.io ZADD argument history |
| `ZRANGE ... BYSCORE` (non-deprecated range) | 6.2 | 7.2 | redis.io ZRANGEBYSCORE deprecation note |
| `HEXPIRE`/`HTTL` (optional) | 7.4 | 9.0 | redis.io HEXPIRE; valkey.io HEXPIRE; probe (absent on 8.1.9) |
| `HSETEX`/`HGETEX` (optional) | 8.0 | 9.0 | redis.io HSETEX/HGETEX; valkey.io HSETEX; probe |

Net: **Redis >= 6.2 and Valkey >= 7.2** for the portable design (verified end-to-end on Valkey 7.2.14, 8.1.9, 9.1.1 and Redis 8.10.1). The hash-field-TTL fast path raises that to Redis 8.0 / Valkey 9.0 and must be feature-detected.

## Sources

node-redis (ctx7 library id `/redis/node-redis`; docs fetched with `npx ctx7@latest docs /redis/node-redis "<topic>"`):

- `docs/command-options.md`: type mapping, `commandOptions.timeout`, `withAbortSignal`, `withCommandOptions`.
- `docs/client-configuration.md`, README "Client Events", `docs/transactions.md`.
- `packages/client/lib/client/socket.ts` (reconnect lifecycle), `packages/client/lib/client/index.ts` (`disableOfflineQueue`).

Installed source, `redis@6.2.1` -> `node_modules/@redis/client/dist/lib/`:

- `RESP/types.d.ts`, `client/index.d.ts`, `client/index.js`, `client/socket.js`, `client/socket.d.ts`, `client/commands-queue.js`, `client/multi-command.js`, `multi-command.js`, `errors.js`.
- `commands/HSET.js`, `HSETEX.js`/`.d.ts`, `HEXPIRE.js`, `HGETEX.d.ts`, `HGETALL.js`, `HMGET.js`, `EXPIRE.js`, `TIME.js`/`.d.ts`, `ZADD.js`/`.d.ts`, `ZRANGE.d.ts`, `ZRANGEBYSCORE.js`, `ZRANGEBYSCORE_WITHSCORES.js`/`.d.ts`.

Server documentation:

- https://redis.io/docs/latest/commands/hsetex/ , https://redis.io/docs/latest/commands/hexpire/ , https://redis.io/docs/latest/commands/hgetex/ , https://redis.io/docs/latest/commands/time/ , https://redis.io/docs/latest/commands/zadd/ , https://redis.io/docs/latest/commands/zrangebyscore/
- https://valkey.io/commands/hsetex/ , https://valkey.io/commands/hexpire/
- Valkey releases: `gh api repos/valkey-io/valkey/releases/tags/9.0.0-rc1` (2025-08-14, "hash field expiration" headline) and `.../9.0.0` (2025-10-21).

Empirical runs (2026-08-21, Docker 29.5.2): `/tmp/redis-probe/probe-commands.mjs` against ports 6390-6393, `/tmp/redis-probe/probe-conn.mjs` against `redis:8`, `/tmp/redis-probe/probe-idle.mjs` against `valkey/valkey:8`. The scripts are reproduced below.

## Appendix: probe scripts

<details>
<summary>probe-commands.mjs</summary>

```js
import { createClient, RESP_TYPES } from 'redis';
const port = Number(process.argv[2]);
const client = createClient({ url: `redis://localhost:${port}` });
client.on('error', e => console.log('client error', e.message));
await client.connect(); await client.flushDb();
const bin = Buffer.from([0x00, 0xff, 0xfe, 0x80, 0x01, 0xc3, 0x28]);
const bufClient = client.withTypeMapping({ [RESP_TYPES.BLOB_STRING]: Buffer });
// (1)
await client.hSet('k', { body: bin, ct: 'text/html', ts: 123 });
await client.hGetAll('k'); await bufClient.hGetAll('k'); await bufClient.hmGet('k', ['body', 'ct']);
await client.withCommandOptions({ typeMapping: { [RESP_TYPES.BLOB_STRING]: Buffer } }).hmGet('k', ['body', 'ct']);
await bufClient.hGet('k', 'body'); await bufClient.hGet('k', 'nope'); await bufClient.hGetAll('nokey');
// (2)
await client.multi().hSet('k2', { body: bin, ct: 'x' }).expire('k2', 100).exec(); await client.ttl('k2');
await client.multi().hSet('k2b', { a: '1' }).pExpire('k2b', 100_000).execTyped();
await bufClient.multi().hSet('k2c', { body: bin }).hGetAll('k2c').expire('k2c', 50).exec();
await client.hSetEx('k3', { body: bin, ct: 'x' }, { expiration: { type: 'EX', value: 100 } });
await client.hTTL('k3', ['body', 'ct']); await client.ttl('k3'); await bufClient.hGetAll('k3');
await client.hSetEx('k3', { ct: 'y' }); await client.hTTL('k3', ['ct']);
await client.hSet('k3', 'body', 'z'); await client.hTTL('k3', ['body']);
await client.hExpire('k', ['body'], 100); await client.hTTL('k', ['body']);
await client.sendCommand(['HSETEX', 'k4', 'NX', 'EX', '10', 'FIELDS', '1', 'a', 'b']);
await client.sendCommand(['HSETEX', 'k5', 'FNX', 'EX', '10', 'FIELDS', '1', 'a', 'b']);
await client.hGetEx('k5', ['a'], { expiration: 'PERSIST' });
// (3)
await client.time(); await client.multi().time().hSet('k6', { a: '1' }).time().exec();
await client.multi().time().get('nope').execAsPipeline(); await bufClient.time(); await client.sendCommand(['TIME']);
// (4)
await client.zAdd('tag:a', [{ score: 1000, value: 'k1' }, { score: 2000.5, value: 'k2' }, { score: 3000, value: 'k3' }]);
await client.zAdd('tag:a', { score: 1500, value: 'k1' }, { comparison: 'GT', CH: true });
await client.zAdd('tag:a', { score: 10, value: 'k1' }, { comparison: 'GT', CH: true });
await client.zRangeByScore('tag:a', '-inf', 2000.5); await client.zRangeByScoreWithScores('tag:a', '(1500', '+inf');
await client.zRangeWithScores('tag:a', 0, '+inf', { BY: 'SCORE' });
await client.zRangeWithScores('tag:a', '+inf', '-inf', { BY: 'SCORE', REV: true, LIMIT: { offset: 0, count: 1 } });
await client.zScore('tag:a', 'k2'); await client.zScore('tag:a', 'zzz');
await client.multi().zAdd('tag:b', { score: 1, value: 'x' }).expire('tag:b', 100).exec();
await client.zRemRangeByScore('tag:a', '-inf', '(1500'); await bufClient.zRangeByScoreWithScores('tag:a', '-inf', '+inf');
const sc = Date.now() * 1000 + 123; await client.zAdd('tag:c', { score: sc, value: 'p' }); await client.zScore('tag:c', 'p');
await client.zAdd('tag:c', { score: 2 ** 53 + 1, value: 'q' }); await client.zScore('tag:c', 'q');
await client.close();
```

(The real script wraps each call in a try/catch logger; the outputs quoted in the sections above are verbatim.)

</details>

<details>
<summary>probe-conn.mjs (excerpt)</summary>

```js
// (5a) pause the server, then:
const withTimeout = c.withCommandOptions({ timeout: 300 }).ping();
const ac = new AbortController(); const withAbort = c.withAbortSignal(ac.signal).ping(); setTimeout(() => ac.abort(), 300);
const manual = Promise.race([c.ping(), sleep(300).then(() => { throw new Error('manual deadline'); })]);
// -> all three still pending after 1500 ms; after `docker unpause` the first two resolve PONG.

// (5b) createClient({ socket: { socketTimeout: 500 } }) + pause -> SocketTimeoutError, client closed (isOpen=false).
// (5c) same + reconnectStrategy: (retries, cause) => Math.min(50 * 2 ** retries, 500) -> reconnects, PONG after unpause.
// (6a) CLIENT KILL ID <id> from a second client; BLPOP in flight rejected, PING queued while !isReady resolved after reconnect.
// (6b) same with disableOfflineQueue: true.
// (6c) docker restart <container>.
```

</details>

<details>
<summary>probe-idle.mjs</summary>

```js
for (const opts of [{ socketTimeout: 1000 }, { socketTimeout: 1000, pingInterval: 400 }]) {
  const c = createClient({ url, socket: { socketTimeout: opts.socketTimeout }, pingInterval: opts.pingInterval });
  await c.connect(); await sleep(2500); console.log(c.isOpen, c.isReady);
}
// -> false,false without pingInterval (SocketTimeoutError after ~1 s idle); true,true with pingInterval=400.
```

</details>
