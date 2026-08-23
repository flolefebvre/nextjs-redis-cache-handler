# Releasing

A release is a version bump merged to `main`, a `vX.Y.Z` tag on the merge commit, and
nothing else: `.github/workflows/release.yml` runs on that tag and does the rest. There
is no CHANGELOG.md — the GitHub Release, generated from the pull requests since the
previous tag, is the changelog.

## Before the first tag

- The repository must be public. npm refuses `--provenance` for a build it cannot link
  to public source, so a private repository fails at the publish step, after the whole
  gate has run.
- The `NPM_TOKEN` repository secret must hold an npm **automation** token for an account
  that can publish under the `@flefebvre` scope. The `guard` job checks it is set before
  anything expensive runs.

## Cutting a release

1. **Bump in a pull request.** Change `version` in `package.json` — nothing else carries
   the version — and open a pull request against `main`. The `ci` workflow runs on it,
   as on any other.
2. **Merge it.** The merge commit is what gets published.
3. **Tag the merge commit.**

   ```sh
   git switch main
   git pull
   git tag v0.1.0
   git push origin v0.1.0
   ```

   The tag must equal the manifest version with a leading `v`. The `guard` job fails the
   run on a mismatch rather than publishing the wrong number.

4. **Watch the run.** `gh run watch` on the `Release` workflow, or the Actions tab. It
   is `guard` → `ci` (the whole CI workflow: the gate, `e2e`, and the server `matrix`)
   → `publish`. Expect the `ci` stage to take the longest; nothing is published until
   every one of its jobs is green.
5. **Verify.**

   ```sh
   npm view @flefebvre/nextjs-redis-cache-handler version
   ```

   It must print the version you tagged. On
   [the package page](https://www.npmjs.com/package/@flefebvre/nextjs-redis-cache-handler)
   the version must carry the provenance badge, linking back to the workflow run that
   built it. Then check the GitHub Release for the tag exists and its generated notes
   list the pull requests since the previous tag.

## If the run fails

Nothing partial survives a failed `guard` or `ci`: no publish happened, so fix the cause,
delete the tag on the remote (`git push --delete origin v0.1.0`) and locally, and tag
again. A failure _after_ `npm publish` succeeded — the GitHub Release step, say — is not
worth re-tagging: the version is on npm and cannot be republished, so cut the release by
hand with `gh release create v0.1.0 --generate-notes --verify-tag`.

## After 0.1.0: switch to trusted publishing

The `NPM_TOKEN` secret exists only because a package that does not yet exist on npm has
no settings page on which to name a trusted publisher. Once `0.1.0` is live, remove the
credential:

1. On npmjs.com, open the package's **Settings → Trusted publisher** and add this
   repository with `release.yml` as the workflow.
2. In `.github/workflows/release.yml`, delete the `guard` job's
   `npm credentials are configured` step, its `env: NPM_TOKEN` block, and the `publish`
   job's `env: NODE_AUTH_TOKEN` block.
3. In the same edit, move the `publish` job's `node-version` to `24`. Trusted publishing
   needs an npm recent enough to exchange the OIDC token for a registry credential, and
   Node 22 does not ship one — npm's own trusted-publisher example pins Node 24.
4. Delete the `NPM_TOKEN` repository secret.

Provenance is unaffected: it comes from the `id-token: write` OIDC token, not from how
npm authenticated the publish.

## Dependency updates

`.github/dependabot.yml` keeps the dependencies moving between releases: npm weekly,
GitHub Actions monthly, no auto-merge — every bump is reviewed and merged by hand. `next`
is excluded from the group, so it arrives on a pull request of its own and a Next.js
release that changes what the Handler is asked to do shows up as a red `e2e` job by
itself. The npm entry names the repository root only, on the assumption that one
`directory` covers the whole pnpm workspace through its single lockfile; the first weekly
run is the proof that the Fixture's exact `next` pin is covered, and if it is not, add
`/e2e/fixture` as a second directory.
