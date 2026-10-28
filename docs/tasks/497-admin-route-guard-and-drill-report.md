# T-497 — Two core safety nets that report "fine" when they are not

**Status:** spec written 2026-10-28 (Opus planner, AUDIT session). Source: Codex core audit reports in
`C:\Users\ianla\shareat-audits\OPEN\` — `core-access-route-guard-2026-10-28.md` (F31) and
`core-recovery-drill-report-2026-10-28.md` (F32). Numbers from the orchestrator. Two slices, two PRs:
S1 = F31 (branch `audit/t497-s1-admin-route-guard`), S2 = F32 (branch `audit/t497-s2-drill-report-failure`).

## S1 — F31 / DEF-794 (P3): the route-coverage guard misses an admin page with no permission-map entry
- `tests/unit/route-capability-coverage.test.ts:113` skips a page when `routeCapability(route)` is null; `:120-127` only
  checks the reverse direction; `:130-142` plants a missing gate only under an already-mapped route.
  `apps/erp/src/lib/route-capability.ts:127` returns null for an unlisted route and `apps/erp/src/lib/page-access.tsx:45`
  admits any established session when the accepted-capability list is empty. So a NEW page under `/admin` or
  `/settings` with no map entry passes the T-288 guard (`docs/tasks/288-staff-pin-sees-every-admin-screen.md:91-97`
  requires enumeration and a red when a route lacks an entry). Bible §7 rule 11: default-deny.
- **Ruling:** the guard enumerates every page under `apps/erp/src/app/admin/**` and `apps/erp/src/app/settings/**` and
  fails when a page's route has NO permission-map entry, unless the route is on an explicit, commented
  `APPROVED_OPEN_ADMIN_ROUTES` list in the test (each entry with the bible row / task that decided it is open; keep the
  bible row 199 / T-288 and T-435 decisions — read them; do not change any page's actual access). If the current tree
  has unmapped admin/settings pages, list them in the report and put each on the approved list ONLY if a recorded
  decision makes it open; otherwise leave the guard red for that page and report it (do not invent a capability).
- **Tests (red first):** a plant of a new unmapped admin page (in-test virtual enumeration, like the existing plant at
  `:130-142`, no real file added) makes the guard fail; the positive control (unmapped page under a mapped route)
  still fails; removing an existing map entry makes it fail; an approved-open route passes.
- Files: `tests/unit/route-capability-coverage.test.ts` (and `apps/erp/src/lib/route-capability.ts` ONLY if a page
  needs an entry a recorded decision already requires), `docs/DEFECTS-REGISTER.md` (DEF-794, full row shape).

## S2 — F32 / DEF-795 (P2): a drill whose required report cannot be saved still signals success
- `scripts/lib/backup/run-drill.ts:105` catches a report write/upload failure and returns null; `:245` stores it as
  `reportKey: null` with `ok` still true; `:248` sends the success heartbeat; `:255` returns success;
  `scripts/restore-drill.ts:62` exits 0 from `r.ok` alone. T-393 R7/R8/R11/R14 (`docs/tasks/393-nightly-backup-and-restore.md:104-111`)
  require the persisted report, failure signalling and a non-zero exit.
- **Ruling:** failing to save the required drill report makes the run FAIL: `ok: false`, a clear reason ("restore
  checks passed but the drill report could not be saved: <reason>"), the failure heartbeat, non-zero exit — while the
  result still carries the true data-check outcome (`mismatches`, timings) and cleanup still runs. Heartbeat DELIVERY
  stays best-effort (R7's exception). If the run already failed and its failure report also cannot be saved, it stays
  failed and says both.
- **Tests (red first), unit with a fake store (no network, no production):** successful restore + `store.put`
  rejecting the report → `ok:false`, failure heartbeat, reason names the report; already-failing drill + report save
  failure → still failed, both reasons; happy path unchanged; `restore-drill.ts` exit code follows `ok`.
  Use the existing backup test helpers (find them under `tests/` / `scripts/lib/backup`). A real-Postgres restore is
  NOT required for these unit cases; do not create or drop any database other than a dedicated `*_test*` scratch.
- Files: `scripts/lib/backup/run-drill.ts`, `scripts/restore-drill.ts` only if needed, the backup unit test file(s),
  `docs/DEFECTS-REGISTER.md` (DEF-795, full row shape).

## Acceptance (each slice)
Red then green; root typecheck clean; the WHOLE unit project green (`npx vitest run --project unit --testTimeout=120000
--maxWorkers=3`, re-run timeout-only failures alone); `tests/unit/register-row-shape.test.ts` green. LF only.
