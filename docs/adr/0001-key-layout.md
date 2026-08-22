# Key layout: verbatim prefix, raw Next.js key, hash-tagged manifest

Every key lives under the Key prefix, used verbatim (`myapp:` → `myapp:…`): Entries at `<prefix>entry:<key>` with
Next.js's cache key stored raw (73–85 bytes, already carries the build id), the Tag manifest at `<prefix>{tags}`
(hash), its log at `<prefix>{tags}:log` (zset) and the Handler clock at `<prefix>{tags}:clock` (string,
ADR 0003). The prefix is the only isolation mechanism between apps sharing one Redis:
Redis databases are not used (Cluster has only database 0, standalone has 16) and never documented.

The braces are a Redis Cluster hash tag: they pin the three keys to one slot so the atomic tag-write script
stays valid if Cluster support is ever added. Cluster is out of scope for v1; the tag is there because renaming
the manifest keys later would split the manifest between old and new instances during a rolling deploy.
