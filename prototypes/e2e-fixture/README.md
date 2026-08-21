# PROTOTYPE (throwaway): e2e fixture shape and entry sizes

Wayfinder ticket #7. A `next@16.3.2` app with `cacheComponents: true` wired to
`logging-handler.cjs`: a plain `cacheHandlers` object that stores Entries and
the tag manifest under `.fixture-store/` (shared by every process, so two
`next start` instances see each other) and appends one JSON line per handler
call to `.fixture-store/log-<port>-<pid>.jsonl`. Not Redis on purpose: the
question is what Next.js does, not what the store does.

## Run

```sh
pnpm install --ignore-workspace
pnpm build          # build-phase handler calls land in log-build-*.jsonl
pnpm drive          # starts :3000 and :3001 on the same build, walks 18 steps
pnpm report         # merged, per-step call sequence + entry-size table
```

## Routes

- `/` static `'use cache'` page (`cacheTag('list-page')`) over `getPosts()` (`cacheTag('posts')`, 50 posts).
- `/posts/[id]` dynamic (PPR) page: `PostBody` `'use cache'` over `getPost(id)`; nested `Comments` `'use cache'` over `getComments(id)` with `cacheLife('short')`.
- `/big` static `'use cache'` page, 500 rich rows.
- Server actions `invalidatePosts` (`updateTag('posts')`), `invalidateComments(id)`.
- `GET /api/revalidate?tag=&expire=|path=&type=` → `revalidateTag` / `revalidatePath`.

Findings are recorded on the ticket and in `docs/nextjs-caching.md` on `main`.
