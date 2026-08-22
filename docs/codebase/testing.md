# Testing

- The suite runs on Vitest 4, in two projects: `unit` (Docker-free, runs first) and `integration` (needs Docker).
- Tests are collocated with the file they test, as `.test.ts` files (`foo.test.ts` next to `foo.ts`). An integration test is named `.integration.test.ts`, which is what puts it in the `integration` project.
- Lay out each test body as Arrange / Act / Assert, one blank line between phases; two phases that fuse into one statement share a block, and a phase a test doesn't have is simply absent.
- The container harness lives in `tests/` (`global-setup.ts`, `redis-container.ts`); test files never wire it themselves. The integration global setup starts one server for the run and hands its URL to every worker: read it with `inject("redisUrl")`.
- `CACHE_TEST_IMAGE` runs the suite against another server image (the default is the single constant `DEFAULT_TEST_IMAGE` in `tests/redis-container.ts`); `CACHE_TEST_REDIS_URL` runs it against an already-running server and starts no container at all.
- A test asserts what a caller can observe — what `get` returns, what the server holds, which hooks fired, how long an operation took. No test inspects internal state, and none uses fake timers or a fake client.
- Every test uses a fresh random key prefix and cleans nothing up.
