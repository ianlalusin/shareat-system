# T-473 — Audit 23 Oct follow-ups on `main`: a failed POS build keeps the last good POS; icon buttons keep their name

**Status:** spec written 2026-10-24 (Opus planner, AUDIT session). Source: Codex read-only audit 2026-10-23
(`C:\Users\ianla\shareat-audits\2026-10-23`, findings 1 and 2), re-verified against `origin/main` 69dca6c.
Branch `audit/t473-deploy-icon-label` off `origin/main`. Defects DEF-753, DEF-754.

## Finding 1 — DEF-753 (P1, release): a failed optional POS build can replace a working POS release

Verified at `.github/workflows/deploy.yml` (main 69dca6c):
- `:100-104` "Build POS v2 (web)" is `continue-on-error: true` (Ian's rule: a POS failure never blocks the ERP).
- `:116` packages POS whenever `apps/pos/.next` EXISTS. `next build` creates `.next` before it can fail, so a
  failed build ships a partial `.next`.
- `:171-177` swaps `/srv/shareat` to the new release and restarts `shareat-pos.service`, whose working directory is
  `/srv/shareat/apps/pos`. With a partial or absent POS tree in the new release, POS goes down. The later POS health
  check only reports it.

**Goal:** a failed POS build ships the ERP and leaves POS on its last good build. The ERP path is unchanged.

Rulings:
1. The POS build step writes a success marker only when the build exits 0:
   `rm -f apps/pos/.pos-build-ok && npm run build -w @shareat/pos && touch apps/pos/.pos-build-ok`.
   `continue-on-error: true` stays.
2. Packaging includes the POS paths only when `apps/pos/.pos-build-ok` exists (not when `.next` exists), and ships
   the marker inside the artifact.
3. On the server, after unpacking and BEFORE the symlink swap: if the new release has no
   `apps/pos/.pos-build-ok`, and the current release (`readlink -f /srv/shareat`) has a POS build (its marker, or
   `apps/pos/.next` for releases older than this change), copy that `apps/pos` into the new release
   (`rm -rf "$RELEASE/apps/pos"` first, then `cp -a`) and print a `::warning::` naming the release it came from.
4. When POS was carried forward, do NOT restart `shareat-pos.service` (the running process is the same build and
   stays up). When the new release has no POS at all (nothing to carry), do not restart it either; print why.
   Otherwise restart exactly as today (`|| echo ...`, never fatal).
5. Every new line lives inside `# >>> POS v2` / `# <<< POS v2` markers so the ERP bytes stay identical
   (`tests/unit/ci-app-jobs.test.ts` case 13 sha must not change). The marker-count assertion in that test is
   updated to the new count; nothing else in it is weakened.

Tests (red first): extend `tests/unit/ci-app-jobs.test.ts` (or a new `tests/unit/deploy-pos-failed-build.test.ts`):
- the POS build step creates the marker only after a successful build (`&& touch apps/pos/.pos-build-ok`);
- packaging is gated on the marker, not on `-d apps/pos/.next`;
- EXECUTE the server-side POS carry-forward block with `bash` against a temp directory standing in for `/srv`
  (substitute the path prefix in the extracted block): (a) new release without marker + previous with marker →
  previous `apps/pos` copied, restart skipped; (b) new release with marker → nothing copied, restart requested;
  (c) neither has POS → nothing copied, restart skipped. `systemctl`/`sudo` are stubbed by a function or PATH shim.
  The test must run under Git Bash on Windows and bash on Linux CI.
- case 13 sha unchanged.

## Finding 2 — DEF-754 (P2, accessibility): an `aria-label={undefined}` erases an icon button's name

Verified at `apps/erp/src/components/ui/Button.tsx:134-136`: the icon branch sets
`aria-label={rest['aria-label'] ?? name}` and THEN spreads `{...rest}`. `FormModal`
(`apps/erp/src/components/ui/Dialog.tsx:142`) always passes `aria-label={triggerLabel}`, `undefined` when a caller
omits `triggerLabel` (e.g. `/ap` "+ Log invoice"). The spread's `undefined` overrides the computed name, the glyph is
`aria-hidden`, and `data-tip` is not an accessible name: a screen reader hears an unnamed button.

Ruling: in the icon branch, spread `rest` first and set `aria-label` last, as `rest['aria-label'] ?? name`.
An explicit caller label still wins. The text branch is unchanged.

Tests (red first), `apps/erp/tests/button-icon-label.test.ts` (`.ts` + `createElement`, as `filter-row.test.ts`):
- `Button` with children `'+ Log invoice'` and `'aria-label': undefined` renders `aria-label="<actionName>"`;
- an explicit `aria-label` still wins;
- `FormModal` with `trigger: '+ Log invoice'` and no `triggerLabel` renders a named trigger
  (`vi.mock('next/navigation')` for `usePathname`/`useSearchParams`).

## Files
`.github/workflows/deploy.yml`, `tests/unit/ci-app-jobs.test.ts` (and/or the new deploy test),
`apps/erp/src/components/ui/Button.tsx`, `apps/erp/tests/button-icon-label.test.ts`,
`docs/DEFECTS-REGISTER.md` (section E: DEF-753, DEF-754). Nothing else.

## Acceptance
New tests red on 69dca6c for the stated reason, green after. `npx vitest run tests/unit/ci-app-jobs.test.ts
apps/erp/tests/filter-row.test.ts apps/erp/tests/button-icon-label.test.ts` plus the guard/census files green; ERP
typecheck clean. Deploy behaviour on the real host is NOT verified by this task (never build or test on a droplet):
the first real proof is the next deploy after merge, and merge is Ian's call.
