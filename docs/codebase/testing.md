# Testing

- The suite runs on Vitest 4, in two projects: `unit` (Docker-free, runs first) and `integration` (needs Docker).
- Tests are collocated with the file they test, as `.test.ts` files (`foo.test.ts` next to `foo.ts`). An integration test is named `.integration.test.ts`, which is what puts it in the `integration` project.
- Lay out each test body as Arrange / Act / Assert, one blank line between phases; two phases that fuse into one statement share a block, and a phase a test doesn't have is simply absent.
- The container harness lives in `tests/` (`global-setup.ts`, `redis-container.ts`); test files never wire it themselves. The integration global setup starts one server for the run and hands its URL to every worker: read it with `inject("redisUrl")`.
- Helpers a unit test shares with another live in `tests/unit-harness.ts`, the Docker-free counterpart of that harness: small, independent functions and types (an `Equals` type, the handler method names, an `entryOf()` Entry factory, a `stopwatch()`), never a framework a test has to be written around. An integration test takes one from there too when the helper needs nothing of Docker.
- `CACHE_TEST_IMAGE` runs the suite against another server image (the default is the single constant `DEFAULT_TEST_IMAGE` in `tests/redis-container.ts`); `CACHE_TEST_REDIS_URL` runs it against an already-running server and starts no container at all.
- A test that breaks the server starts one of its own, with `startOutageRedis` from the same harness: it needs Docker, so the outage tests are skipped when `CACHE_TEST_REDIS_URL` is set. The shared server of the run is never paused or stopped — every other worker is talking to it.
- A duration a test measures comes from the monotonic clock, through `stopwatch()` in `tests/unit-harness.ts`, never from `Date.now()`: a host whose wall clock steps backwards mid-test — an NTP correction, a virtual machine resyncing — hands back an elapsed time short by the step, negative ones included. `Date.now()` stays where a test produces a _timestamp_, an Entry's among them.
- A test asserts what a caller can observe — what `get` returns, what the server holds, which hooks fired, how long an operation took. No test inspects internal state, and none uses fake timers or a fake client.
- Every test uses a fresh random key prefix and cleans nothing up.
