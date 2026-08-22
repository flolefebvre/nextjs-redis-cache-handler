# CI

`.github/workflows/ci.yml` is one job on `ubuntu-latest`, run on every pull request and every push to `main`, and callable by a release workflow through `workflow_call` so the release path runs this exact gate. A superseded run on the same ref is cancelled, except on `main`, where every push keeps its run.

- Run the checks as one job step per `gate` script, in the gate's order, so a failing check names itself in the run summary.
- Pin `node-version` to the major the repo is developed on. `engines` only sets a floor (`>=22.12.0`), so a spec taken from it would let CI drift onto a major nobody has run.
- Keep `pnpm/action-setup` ahead of `actions/setup-node`, which needs pnpm on the PATH for `cache: pnpm`. The repo has no `packageManager` pin — a published library must not impose one on its consumers' toolchain — so the pnpm major is named in the workflow.
- The Test step needs the runner's Docker daemon: the `integration` project starts its own throwaway Valkey.

Before pushing a change to the workflow, lint it with `docker run --rm -v "$PWD:/repo" -w /repo rhysd/actionlint:latest`, and reproduce CI's environment by running `pnpm gate`.
