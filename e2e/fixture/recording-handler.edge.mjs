/**
 * The Edge target of the Fixture's Handler slot module: the library's Zero-config entry,
 * which the `edge-light` condition answers with the disabled handler.
 *
 * Nothing is recorded here — an Edge bundle has no filesystem — and nothing is called
 * either: measured on 16.3.2, a pages-router render reaches no Cache Handler method at
 * all, so what this target proves is that the Edge bundle links the disabled handler and
 * not the Node.js one, which is what keeps the build passing.
 */
export { default } from "@flefebvre/nextjs-redis-cache-handler/handler";
