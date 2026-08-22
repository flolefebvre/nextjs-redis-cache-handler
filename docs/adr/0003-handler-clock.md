# The Handler clock: one non-decreasing clock, in the tag slot

ADR 0002 rests on "one Redis clock", and that premise does not hold: `TIME` is a wall clock, and a wall clock
steps backwards — an NTP correction on the Redis host (a WSL2 host stepped back ~1 s every ~15 s while #61 was
being diagnosed), a Sentinel failover to a primary whose clock differs, and on Cluster every node keeps a clock
of its own while Entries live in slots the `{tags}` keys never share. A step between an Entry's write and a tag
event makes the event's instant precede a Write time that really came first, and `expiredAt > writeTime` then
serves output the mutation replaced. So every instant this handler compares now comes from a **Handler clock**:
`<keyPrefix>{tags}:clock`, one string holding the last stamp issued in milliseconds, in the slot the manifest
and the log already share. Every script computes `max(TIME, last)`; the stamping ones persist it when it moved
the clock on, the two manifest reads persist nothing. The clock therefore never runs backwards, it never sits
more than the last backward step ahead of wall time, and that excess shrinks to nothing as wall time catches up
— so under a backward step of S it freezes at the floor for S seconds and self-heals, and whatever the load, it
runs at time's rate.

Two stamps can then share an instant, so the ordering is closed in the comparison instead: an event stamped on
the very millisecond of a Write time counts as later than it, `staleAt >= writeTime` and `expiredAt >=
writeTime`. The tie drops the Entry, which is the side ADR 0002 already chooses — an Entry is dropped, never
wrongly served — and it is the only cost of the freeze, along with an Entry generated after a tag event being
dropped for as long as the clock stands still, bounded by the size of the step. The Instance's own projection of
the clock never gives back time it has counted either: a frozen clock would otherwise come back identical from
every refresh and the projection would stand still with it, holding past its due date an expiration a
`durations` had scheduled. It keeps the later of the refresh and what it had counted on its monotonic clock,
which leaves it at most one step ahead of the shared clock — ahead only ever drops an Entry sooner.

`set` costs two round trips: a `tick` on the clock key, then the Entry write with `writeTime = stamp − age`
computed by the Instance and passed in. `get` still costs one and issues no stamp, and `set` is off the
request's critical path, which is what makes the second trip affordable; any delay between the two only makes
the Entry look older, the safe side again. The split is also what keeps every script routable on Cluster: the
tick touches the `{tags}` slot alone, the write the Entry's slot alone. The Entry write stays a Lua script
rather than becoming a `MULTI` of `HSET` and `EXPIRE` — the same single round trip, one atomic unit, and nothing
the client would have to grow for it — even though it no longer reads a clock.

Pruning is the one place the clock's rate would meet the wall clock, and it is taken off the wall clock for
that reason: an Entry key expires on `TIME`, so a cutoff of `TIME − maxTtl` states the invariant the write
script keeps — no living Entry has a Write time older than the cutoff — with no condition on steps or load. The
Handler clock is never below the wall clock, so a wall-clock cutoff is always the more conservative of the two.
Both prunings use it: the shared one in the tag-event script, and the local one, which is why a refresh brings
back the wall clock beside the stamp.

Reads stay read-only for two reasons. One write per request per Instance is a permanent addition to the
replication stream and the AOF, for a value only the stamping scripts need to record. And the case a read-only
read leaves open is exactly the one the manifest's existing backward-step fallback covers: a read returns
X = `TIME` while X > `last`, the wall clock then steps back by S, the next stamp lands at `max(TIME − S, last)`,
which can sit below the watermark X − 1 s; the following read then returns a clock below that watermark,
`mergeWith` refuses to merge, and the full read that follows brings the event in. That fallback is load-bearing
here, not vestigial.

A lost clock key — evicted, or dropped by a `FLUSHDB` — starts the clock again from `TIME`. Entries written
after the loss are then stamped below the events already recorded and are dropped rather than served, but the
other direction is exposed: an Entry stamped at the old floor while the wall clock sat behind it is not beaten
by a tag event stamped after the loss until the wall clock passes that floor again, at most the size of the
step that was in progress. That window is accepted rather than closed, because it takes the key being lost
during a backward step, and because the tag slot is assumed not to be evicted at all — losing the manifest
itself drops every invalidation it holds, which is the larger exposure and the reason a store this handler is
pointed at should not evict those keys.

Rejected: a Lamport clock, `max(TIME, last + 1)` persisted at every stamp, which is what this decision first
was. It breaks ties by construction, but it advances one millisecond per stamp rather than with time, so above
a thousand stamps per second on one Key prefix it runs faster than the clock the Entry keys expire on, without
bound while the load lasts, and it halves an `expire-after` under twice that load. Also rejected: a continuous
offset clock (`offset += last − TIME` on each step), which never heals; stamping the Entry from the Instance's
own projection, which costs no round trip but advances while the shared clock is frozen, so a concurrent tag
event could still lose; a tolerance margin on the comparison, unbounded for the reason ADR 0002 gives; and
reading the clock key inside the Entry write script, which is cross-slot on Cluster.
