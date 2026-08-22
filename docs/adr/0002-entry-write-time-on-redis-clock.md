# Entry write time on the Redis clock

Tag events are stamped with Redis `TIME` (ADR-less, decided with the watermark read), but `entry.timestamp` is the
app instance's `Date.now()` at generation start. Comparing the two across clocks is the one place skew can keep a
stale Entry: an app clock ahead of Redis makes a render that started _before_ a mutation look written _after_ it,
and the Entry is then served until `expire`. So `set` stores a second field, the Write time: the script receives
`age = Date.now() − entry.timestamp` (measured on one clock, skew-free) and writes `TIME − age`. `get` compares
the Tag manifest against the Write time only; `entry.timestamp` is stored and returned untouched, so every
duration check the Next.js wrapper does (`expire`, `revalidate`) is unaffected. `getExpiration` returns `Infinity`
so the soft-tag check also happens in `get`, against the same clock (a declared divergence from the Oracle).

Rejected: keeping Next.js's timestamp with a documented skew tolerance (the tolerance cannot be bounded: a miss
needs only `skew > mutation − render start`); translating the manifest to the app clock with a per-instance
offset (a second moving part, re-measured per request, noisier); re-stamping with `TIME` at `set` (loses the
render duration, so a tag invalidated mid-render no longer beats the Entry); a fixed safety margin (the residual
error is milliseconds and already biased toward dropping: any delay between computing `age` and the script
running makes the Entry look older). Skew between _app_ hosts still shifts `expire`/`revalidate` by that skew on
cross-instance reads; that is Next.js's own comparison and is documented, not corrected.
