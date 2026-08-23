/**
 * The Edge target of the Fixture's Handler slot module: the library's Zero-config entry,
 * which the `edge-light` condition answers with the disabled handler.
 *
 * Nothing is recorded here — an Edge bundle has no filesystem — so a request served by an
 * Edge-bundled route produces no Recorded call, and the handler reports once that the
 * scope rendered uncached.
 */
export { default } from "@flefebvre/nextjs-redis-cache-handler/handler";
