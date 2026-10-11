# T-399 — Make the self-hosted runner reuse its own disk

> **Status: SPEC.** From Ian, 2026-10-11, the same day the self-hosted runner `ians-pc` (label
> `shareat-local`, `docs/ops/self-hosted-runner.md`) went live and `CI_RUNNER` was set: *"any other
> optimization we can do to make our development faster?"* then *"yes, write the spec and open a
> branch"*. Branch `lane/t399-runner-caches`.

## The goal

The runner is on Ian's PC. Its disk persists between jobs, but the internet link is slow: the
227 MB `actions/runner` download took about 5 minutes (11 Oct). Two things in the workflows still
behave as if every job started on a fresh GitHub-hosted VM:

1. **`actions/setup-node` with `cache: npm`** (both `ci.yml` `verify` and `deploy.yml`) downloads
   the npm cache tarball from GitHub's cache service at the start of every job and uploads a new
   one at the end. On this PC, `~/.npm` is already there from the last job. Over this link the
   round trip is likely the single largest avoidable cost.
2. **The Next.js build cache is thrown away.** Next is **16.3.2**. From 16.3.0, Turbopack's
   filesystem cache for `next build` is **on by default** and lives in `apps/erp/.next/cache`
   (`node_modules/next/dist/docs/01-app/03-api-reference/05-config/01-next-config-js/turbopackFileSystemCache.md`).
   `actions/checkout` runs `git clean -ffdx` by default, which deletes the gitignored `.next`
   folder, so every CI build starts cold.

## ⛔ Finding, independent of speed: the deploy artifact ships the build cache

`deploy.yml` packs the artifact with
`PATHS="apps/erp/.next … node_modules"` and `tar -czf … $PATHS`. That includes
`apps/erp/.next/cache`. Since 16.3.0 that directory holds the Turbopack build cache. Production
never reads it. Every deploy therefore uploads it over the slow link to `159.223.46.224` and
unpacks it on a 4 GB box.

**Fix in this task:** add `--exclude='apps/erp/.next/cache'` to that `tar`. Verify by listing the
artifact (`tar -tzf … | grep -c '.next/cache'` must print `0`), and compare the artifact size before
and after.

## The changes

### Slice 1 — npm: use the local cache when self-hosted

In `ci.yml` (`verify`) and `deploy.yml`:

```yaml
- uses: actions/setup-node@v4
  with:
    node-version: ${{ env.NODE_VERSION }}
    # T-399: on the self-hosted runner ~/.npm persists between jobs; GitHub's cache service would
    # only download and re-upload it over a slow link. Hosted runners keep the GitHub cache.
    cache: ${{ vars.CI_RUNNER == '' && 'npm' || '' }}
```

- Unset `CI_RUNNER` evaluates to `null`. GitHub's loose `==` treats `null == ''` as true, so hosted
  runs keep `cache: npm`. **Prove this; do not assume it.** One hosted run (temporarily unset the
  variable) must log "Cache restored" or "Cache not found" from setup-node. One self-hosted run must
  log neither.
- `npm ci` still deletes `node_modules` and reinstalls from `~/.npm` on local disk. Do not switch to
  keeping `node_modules`. `npm ci` from a warm local cache is fast, and a reused `node_modules`
  folder would leave packages a PR removed still installed.

### Slice 2 — Next build cache: keep it between CI runs (CI only)

In `ci.yml` `verify`, around the existing `Build` step, and only when self-hosted
(`if: vars.CI_RUNNER != '' && needs.changes.outputs.docs_only != 'true'`):

- **Before Build — restore:** if `~/.cache/shareat/next-ci` exists, `mkdir -p apps/erp/.next` and
  `cp -a ~/.cache/shareat/next-ci apps/erp/.next/cache`. Allow failure (`|| true`): a missing or
  broken cache must only cost time, never fail the job.
- **After Build — save** (`if: success()` plus the condition above): replace
  `~/.cache/shareat/next-ci` with `apps/erp/.next/cache`. Use `rm -rf` on a temporary name, then
  `mv`, so a half-copied cache is never left in place.
- **Path:** `~/.cache/shareat/next-ci`, outside the workspace, so `git clean` cannot touch it.
  The path is CI-specific on purpose (see below).

**Deploy stays cold. This is deliberate.** The production artifact must come from a build that
nothing earlier could have influenced. If a Turbopack invalidation bug ever produced a stale but
green CI build, a cold deploy build is the backstop that catches it. Deploys run only on pushes to
`main`, so the cost is small. Do not add a cache to `deploy.yml`, and do not let the two workflows
share a cache directory: CI builds with dummy `NEXT_PUBLIC_*` values, deploy with real ones.

**Disk:** the cache is replaced on every save, never added to, so it stays one build's worth of
data. The runner's disk has 953 GB free (11 Oct).

## Rejected

- **Split `verify` into parallel jobs.** One runner runs one job at a time, so split jobs would
  only queue. A second runner on the same PC would compete for the 7.6 GB that WSL gives the VM.
- **`actions/cache` for `.next/cache`.** It goes through GitHub's cache service: the same slow
  round trip this task removes.
- **`checkout` with `clean: false`.** It would keep `.next` and `node_modules`, but it would also
  keep every stray untracked file a previous job left behind. Copying one known directory is
  narrower.
- **Raise WSL memory now.** Wait for evidence: if a self-hosted run fails with exit 134 or an
  out-of-memory error, add `memory=10GB` under `[wsl2]` in `C:\Users\ianla\.wslconfig`, and record
  that it was done.

## Acceptance

1. **Baseline.** Record the wall time of the first self-hosted `verify` run made *before* this
   change: total time, plus the `Install` and `Build` steps.
2. **Slice 1.** On the runner, the `setup-node` step makes no cache download or upload, and
   `Install` is faster than the baseline. A hosted run still uses `cache: npm`.
3. **Slice 2.** On the second self-hosted run after merge, `Build` is faster than on the first. The
   restore step logs that it found the cache. With `~/.cache/shareat/next-ci` deleted, the job is
   still green and only slower.
4. **Deploy.** The artifact contains no `.next/cache` entries. Record the size before and after.
   The deploy builds with no cache restored.
5. **Rollback is unchanged.** Deleting `CI_RUNNER` sends every job back to GitHub-hosted runners,
   and nothing in this task runs there.

Put the numbers in this file under `## Outcome`. They are the evidence; "it felt faster" is not.

## Files

- `.github/workflows/ci.yml`: the `setup-node` cache expression, plus the restore and save steps
  around `Build`.
- `.github/workflows/deploy.yml`: the `setup-node` cache expression and the `tar --exclude`.
- `docs/ops/self-hosted-runner.md`: one short section, "Caches on the runner": where they live,
  how to clear them (`rm -rf ~/.cache/shareat/next-ci ~/.npm`), and the fact that deploy is never
  cached.
