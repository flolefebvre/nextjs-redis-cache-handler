/**
 * The Zero-config entry: the module an app registers, by path — `cacheHandlers: { default:
 * handlerPath }` — or by specifier — `require.resolve('@flefebvre/nextjs-redis-cache-handler/handler')`.
 *
 * It holds no handler of its own. It re-exports the one its runtime can run, through a
 * self-reference that Node.js and the bundlers resolve against this package's own
 * `exports` map: `./dist/handler.node.js` everywhere, `./dist/handler.edge.js` under the
 * `edge-light` condition. The indirection is what makes the path form work at all — Next.js
 * hands the Edge bundler this file's absolute path, which it imports as a relative file, so
 * no condition applies to it; the bare specifier inside it is the only thing left that the
 * `exports` map can still speak to.
 *
 * `@flefebvre/nextjs-redis-cache-handler/handler-target` is internal. It exists for this
 * re-export and for nothing else, and it is not part of the package's public surface.
 */
export { default } from "@flefebvre/nextjs-redis-cache-handler/handler-target";
