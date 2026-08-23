# nextjs-redis-cache-handler

## Context

`@flefebvre/nextjs-redis-cache-handler` is a published library: a Redis/Valkey-backed cache handler for Next.js Cache Components (`'use cache'`), so that every Instance of a multi-instance deployment shares the same cached output and sees the same revalidation events.

Its domain language is `CONTEXT.md`'s and is binding — use those words, avoid the ones it tells you to avoid. `docs/adr/` records the architectural decisions, `docs/nextjs-caching.md` is the reference for every Next.js behaviour the handler depends on, and `docs/research/` holds the evidence behind both.

## Stack

- TypeScript 5, `strict`, ESM only, built with `tsc` (NodeNext, ES2022) — no bundler
- node-redis 6 (`redis`) as the only runtime dependency
- `next` as a peer dependency, never imported at runtime: its cache handler interface is vendored in `src/types.ts`
- Vitest 4 and Testcontainers for the test suite
- ESLint 10 flat config, Prettier 3, jscpd 4 (copy/paste detection)
- tsx, for the repo scripts

## Layout

```
src/            Library source, collocated .test.ts and .integration.test.ts
  index.ts        The `.` entry: the factory, its options type, handlerPath, the vendored types
  index.edge.ts   Its Edge target, resolved through the `edge-light` condition
  handler.ts      The `./handler` entry: a re-export of the target its runtime can run
  handler.node.ts Its Node.js target: the Zero-config handler object
  handler.edge.ts Its Edge target: the disabled handler, no redis and no node: import
  types.ts        The vendored Next.js cache handler interface
scripts/        Repo tooling, run with tsx
tests/          Test harness wiring, and tests that exercise it
  dist-consumer/  A consumer compiled against the built output, for typecheck:dist, and the
                  .mjs/.cjs processes smoke:dist runs against it
e2e/            The e2e harness, and one .e2e.test.ts per Scenario
  fixture/        The Fixture app: a Next.js app consuming the built output by package name
  fixture-build.ts  The one `next build` of a run, and the build Key prefix it writes under
  instances.ts    startInstances(): a Scenario's fresh Instance pair, on a seeded prefix
  pages.ts        The Fixture's paths, and the markers each of its pages owes
  records.ts      The Recorded calls, sliced by offset and awaited with waitFor
docs/
  codebase/     Conventions, one file per area, linked from the AGENTS.md section it governs
  adr/          Architectural decisions
  research/     Evidence gathered before the decisions
  agents/       Agent skills, linked from the section below
```

## Commands

```
pnpm gate            Format check, lint, duplication, typecheck, test, build, pack:check, typecheck:dist, smoke:dist, test:e2e — the full check; needs Docker running
pnpm build           Clean and compile to dist/ with tsc
pnpm format          Prettier, rewriting files in place
pnpm format:check    Prettier in check mode (fails on unformatted files)
pnpm lint            ESLint flat config (eslint.config.mjs), warnings are failures
pnpm duplication     jscpd copy/paste detection (.jscpd.json); any clone is a failure
pnpm typecheck       TypeScript with no emit, over src, tests, scripts and the e2e harness
pnpm test            Vitest, once, the unit and integration projects; needs Docker running
pnpm test:unit       The unit project only (Docker-free)
pnpm test:integration The integration project only; needs Docker running
pnpm test:e2e        The e2e project; needs Docker running, and `pnpm build` first
pnpm pack:check      Assert what `npm pack` would ship (build first)
pnpm typecheck:dist  Compile a consumer against the built output through the exports map (build first)
pnpm smoke:dist      Load the built ./handler from an ESM and a CommonJS process (build first)
```

**Before considering a change done:** run `pnpm gate`. It passed only if the output ends with `--gate OK--` — anything else is a failure, whatever the rest of the output says.

The sequence is the `gate` line in package.json; add a check by adding its script name there, and to the CI workflow that runs the same list. See `docs/codebase/ci.md`.

## Testing

This project uses TDD. Tests are collocated with the file they test. See `docs/codebase/testing.md` before writing tests.

## Documentation

Always reach for documentation rather than working from memory. Prioritize the files below first, and then ctx7. Repo conventions live in `docs/codebase/`, linked from the section they govern; the sources below are external reference.

- `docs/nextjs-caching.md` — the reference for what Next.js does to the handler: call order per request, `updateTags` argument forms, module loading, process lifecycle, measured Entry sizes. A ticket that establishes a new Next.js behaviour appends it there.
- `node_modules/next/dist/server/lib/cache-handlers/types.d.ts` — the interface this library vendors. `src/types.ts` must stay identical to it in shape; `src/types.test.ts` fails the typecheck if it does not.

## Comments and docs

Don't write explanatory comments in the code — `pnpm lint` fails on any comment that is not JSDoc or a directive. JSDoc (`/** … */`) is allowed and expected on exported symbols: it is this package's public documentation. The user will guide you if any addition to `docs/` is necessary.

## Language

Prose in this repo — docs, commit messages, issues — is written in English, regardless of the language used in conversation.

## Agent skills

### Issue tracker

Issues are tracked in this repo's GitHub Issues (`flolefebvre/nextjs-redis-cache-handler`) via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.

## Keeping this file current

If your changes mandate an update to a section of this `AGENTS.md` file, make the change. Do not add any sections on your own.
