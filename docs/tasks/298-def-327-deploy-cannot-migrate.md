# T-298 — DEF-327: the deploy's migrate step connects as the app role, which by design cannot migrate

> **Status: RESERVED 2026-09-13 by system32-85 — dispatched to lane A (webapps-65, Sonnet 5).**
> Number reserved before dispatch so no other session can take it. Spec to be written by the lane
> and approved by the orchestrator before any edit.

Source: measured, not hypothesised — `gh run view 34680033997 --log-failed`.

## What was measured, before any theory

| Fact | Evidence |
|---|---|
| Last SUCCESSFUL Deploy | run `34673471861`, 2026-09-12 04:36:58 UTC — `Migrations applied in 231ms`, `healthy after 1 attempt(s)` |
| Next Deploy | run `34680033997`, 2026-09-12 07:10:31 UTC — **`Migration FAILED: PostgresError: permission denied for database defaultdb`**, code `42501`, `aclchk.c:2793` |
| Both ran against | the same host, the same `.../defaultdb?sslmode=require` |
| `55fc4bd` (added the `orphan-file-sweep` npm script) | committed 2026-09-12 05:23:45 UTC — **after** the last good deploy, **before** the failed one |
| Deploys since | `34699912489` and `34700481646` both **skipped** — CI was red (DEF-325), so `workflow_run` never fired the job |

## Why nothing has deployed, in one line

`deploy.yml`'s remote heredoc runs `npm run db:migrate` under `set -euo pipefail`, and the migrate
step is **before** the symlink swap and the restart:

```
cd "$RELEASE"
npm run db:migrate            # <- fails 42501
ln -sfn "$RELEASE" /srv/shareat.new
mv -Tf /srv/shareat.new /srv/shareat
sudo /usr/bin/systemctl restart shareat-erp.service
```

So the artifact unpacks, the migration is refused, `set -e` aborts, and `/srv/shareat` still points
at the release built before `55fc4bd`. **That is precisely why the unit's log says
`npm error Missing script: "orphan-file-sweep"`.** The deploy failed SAFE — the comment in the
workflow claims exactly this behaviour and it held — but it failed silently as far as the host was
concerned.

## The cause is already written down in this repository

`docs/ops/README.md` §"⛔ THE CONSEQUENCE THAT WILL BITE: migrations on the box must use the ADMIN
string" — written 2026-09-12, the same day:

> `npm run db:migrate` reads `DATABASE_URL`. `shareat_app_prod` is `NOCREATEDB NOCREATEROLE` and
> owns no table, so it **cannot run a migration** — correctly, and by design. A deploy or a manual
> migrate that inherits the file as written will fail with a permission error.

The doc gave the manual recipe and **the deploy pipeline was never given the same treatment.** The
prediction was correct and unacted-on for one line of YAML.

## Out of scope — hard

- ⛔ Do **not** grant `shareat_app_prod` any DDL right, and do **not** let it own a table. The ops
  doc says why, and the reason is the whole point of the 2026-09-12 role change.
- ⛔ Do not touch `docs/ops/README.md` — lane C owns that file this cycle. Report the paragraph.
- ⛔ Do not touch `packages/db/migrate.ts` without saying why in the spec.
