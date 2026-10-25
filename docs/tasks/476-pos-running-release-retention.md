# T-476 — Never prune the release the running POS process lives in

**Status:** spec written 2026-10-24 (Opus planner, AUDIT session). Source: Codex audit fifth pass (2026-10-24,
`C:\Users\ianla\shareat-audits\OPEN\audit-2026-10-24-fifth-pass.md`, new P1), re-verified on main f85e5d5.
Branch `audit/t476-pos-release-retention` off `origin/main`. Defect DEF-770. Numbers from the AUDIT block (BOARD.md).

## Finding — DEF-770 (P1, release)
T-473 (DEF-753, merged in f85e5d5) skips restarting `shareat-pos.service` when a deploy carries the last good POS
forward. The unit (`docs/ops/shareat-pos.service`: `WorkingDirectory=/srv/shareat/apps/pos`) resolves the symlink when
the process STARTS, so the running process stays in the physical release it started from. The cleanup at the end of the
remote script (`ls -1dt /srv/shareat-releases/*/ | tail -n +4 | xargs -r rm -rf`) keeps only the newest 3 releases, so
after three consecutive deploys whose POS build fails, it deletes the directory the live POS process is still running
from; lazily loaded chunks and static files then fail. (A crash restart by systemd is fine: it starts in the current,
carried-forward copy.)

## Rulings
1. Record which release the running POS lives in: `/srv/shareat-releases/.pos-running` (a one-line file holding the
   release path, inside the releases dir the deploy user already writes; dot-name so the `*/` glob never lists it).
   - When the deploy restarts POS (`POS_RESTART=1` and the unit is installed and the restart command succeeds), write
     `$RELEASE` to it.
   - When POS is carried forward and the file does not exist yet, write `$PREV_RELEASE` (the release the running process
     came from before this deploy). If the file exists, leave it unchanged (chained carry-forwards keep the original).
2. The cleanup never deletes the release named in `.pos-running` (compare by resolved path, trailing slash
   normalised). With it protected, up to 4 releases may remain; that is accepted.
3. The cleanup line is ERP bytes and stays unchanged. Protection is done in a POS v2 block placed just BEFORE it:
   `touch -m` the protected release directory, so `ls -1dt` sorts it among the newest and `tail -n +4` skips it (the
   order becomes protected, current, previous; older ones are pruned as before). Every new line sits inside
   `# >>> POS v2` / `# <<< POS v2` markers; the case-13 sha in `tests/unit/ci-app-jobs.test.ts` must not change.
   Never fatal: any failure in these lines prints a `::warning::` and the deploy continues.
4. The marker-count assertion in `ci-app-jobs.test.ts` is updated to the new count only.

## Tests (red first) — extend `tests/unit/deploy-pos-failed-build.test.ts`
Execute the extracted server blocks (carry-forward, restart, retention, and the real cleanup line) with bash against a
temp `/srv` stand-in: (a) good deploy A (restart, marker = A), then three deploys B, C, D with failed POS builds →
release A still exists, marker still A, B..D carry POS; (b) a later good deploy E restarts POS and sets marker = E, after
which A may be pruned; (c) first carry-forward with no marker file sets it to the previous release; (d) a failing
`touch`/write prints a warning and the script still reaches the ERP swap and cleanup.

## Files
`.github/workflows/deploy.yml`, `tests/unit/deploy-pos-failed-build.test.ts`, `tests/unit/ci-app-jobs.test.ts` (marker
count only), `docs/DEFECTS-REGISTER.md` (section E, DEF-770). Nothing else.

## Acceptance
New cases red on f85e5d5, green after; `ci-app-jobs`, the deploy tests and the guard/census files green. Real-host proof
is a later deploy (never run anything on a droplet).
