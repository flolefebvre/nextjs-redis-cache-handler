/**
 * The Handler slot module of the Fixture app: the recording wrapper, in the target the
 * runtime that loads it can run.
 *
 * `cacheHandlers` entries are bundled into every Edge-bundled route, so this module is
 * compiled for the Edge runtime too. The `#recording-handler-target` subpath is the
 * package-internal seam the `edge-light` condition answers, exactly as the library's own
 * `./handler` entry does: an Edge bundle gets the disabled handler and no `node:` import.
 */
export { default } from "#recording-handler-target";
