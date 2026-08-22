import { createDisabledHandler, EDGE_UNSUPPORTED } from "./disabled-handler.js";
import type { CacheHandler } from "./types.js";

/**
 * The Edge target of the Zero-config entry: the same plain handler object, disabled.
 *
 * No Redis client runs on the Edge runtime — it has no sockets — so an Edge bundle that
 * pulled the Node.js target in would not merely be useless, it would fail the build:
 * `redis` reaches `node:net`, `node:tls` and `node:crypto`, which neither bundler can
 * resolve for Edge. Configuring this handler must never break a build, so an Edge bundle
 * gets this instead: no `redis`, no `node:` module, no environment read, nothing thrown at
 * load. A `'use cache'` scope of an Edge route then renders uncached, and says so once —
 * the same degradation, and the same single loud line, as a Node.js process with no
 * `REDIS_URL`.
 *
 * The shape is the Node.js target's, down to the plain object with no `default` property:
 * Next.js unwraps `default` twice whichever runtime loads the module.
 */
const handler: CacheHandler = createDisabledHandler(EDGE_UNSUPPORTED);

export default handler;
