# The Handler clock: one non-decreasing clock, in the tag slot

ADR 0002 rests on "one Redis clock", and that premise does not hold: `TIME` is a wall clock, and a wall clock
steps backwards — an NTP correction on the Redis host (a WSL2 host stepped back ~1 s every ~15 s while #61 was
being diagnosed), a Sentinel failover to a primary whose clock differs, and on Cluster every node keeps a clock
of its own while Entries live in slots the `{tags}` keys never share. A step between an Entry's write and a tag
event makes the event's instant precede a Write time that really came first, and `expiredAt > writeTime` then
serves output the mutation replaced. So every instant this handler compares now comes from a **Handler clock**:
`<keyPrefix>{tags}:clock`, one string holding the last stamp issued in milliseconds, in the slot the manifest
and the log already share. A stamping script computes `max(TIME, last + 1)` and persists it, so stamps are
strictly increasing and a tag event issued after an Entry write beats it whatever the wall clock did; the two
reads of the manifest return `max(TIME, last)` and persist nothing. Under a backward step of S the clock freezes
at the floor and advances a millisecond per stamp until the wall clock catches up, so it self-heals in S
seconds; during the freeze an Entry generated after a tag event can be dropped one extra time, which is the side
ADR 0002 already chooses — an Entry is dropped, never wrongly served.

`set` therefore costs two round trips: a `tick` on the clock key, then the Entry write with
`writeTime = stamp − age` computed by the Instance and passed in. `get` still costs one and issues no stamp, and
`set` is off the request's critical path, which is what makes the second trip affordable; any delay between the
two only makes the Entry look older, the safe side again. The split is also what keeps every script routable on
Cluster: the tick touches the `{tags}` slot alone, the write the Entry's slot alone. The Entry write stays a Lua
script rather than becoming a `MULTI` of `HSET` and `EXPIRE` — the same single round trip, one atomic unit, and
nothing the client would have to grow for it — even though it no longer reads a clock.

Reads stay read-only for two reasons. One write per request per Instance is a permanent addition to the
replication stream and the AOF, for a value nothing needs to be strictly increasing — the verdict only compares
stamps that stamping scripts issued. And the case a read-only read leaves open is exactly the one the manifest's
existing backward-step fallback covers: a read returns X = `TIME` while X > `last`, the wall clock then steps
back by S, the next stamp lands at `max(TIME − S, last + 1)`, which can sit below the watermark X − 1 s; the
following read then returns a `serverNow` below that watermark, `mergeWith` refuses to merge, and the full read
that follows brings the event in. That fallback is load-bearing here, not vestigial, and it is also what a lost
clock key — evicted, or dropped by a `FLUSHDB` — falls back on: the clock starts again from `TIME`, which makes
fresh Entries look older than the events already recorded, so they are dropped rather than served.

Rejected: a continuous offset clock (`offset += last − TIME` on each step) — it never heals, and on a host that
steps repeatedly the handler clock drifts away from the key-TTL clock without bound, which erodes the pruning
invariant that no living Entry has a Write time older than the cutoff; stamping the Entry from the Instance's
own projection `manifest.serverNow()`, which costs no round trip but advances while the Handler clock is frozen,
so a concurrent tag event could still lose; a tolerance margin on the comparison, unbounded for the reason ADR
0002 gives; and reading the clock key inside the Entry write script, which is cross-slot on Cluster.
