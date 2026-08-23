# CI

`.github/workflows/ci.yml` is two jobs on `ubuntu-latest` — `ci`, the gate, and `e2e` — run on every pull request and every push to `main`, and callable by a release workflow through `workflow_call` so the release path runs this exact gate. A superseded run on the same ref is cancelled, except on `main`, where every push keeps its run.

- Run the checks as one job step per `gate` script, in the gate's order, so a failing check names itself in the run summary.
- Pin `node-version` to the major the repo is developed on. `engines` only sets a floor (`>=22.12.0`), so a spec taken from it would let CI drift onto a major nobody has run.
- Keep `pnpm/action-setup` ahead of `actions/setup-node`, which needs pnpm on the PATH for `cache: pnpm`. The repo has no `packageManager` pin — a published library must not impose one on its consumers' toolchain — so the pnpm major is named in the workflow.
- The Test step needs the runner's Docker daemon: the `integration` project starts its own throwaway Valkey.
- The `e2e` job is separate, and runs on every pull request like the gate: it installs, runs `pnpm build` — the Fixture app consumes the built output through the `exports` map — and then `pnpm test:e2e`, which is also the gate's last step. Its budget is minutes rather than seconds, so it carries its own `timeout-minutes` (10, for a 2–4 minute run) and leaves the `ci` job's alone.

Before pushing a change to the workflow, lint it with `docker run --rm -v "$PWD:/repo" -w /repo rhysd/actionlint:latest`, and reproduce CI's environment by running `pnpm gate`.
