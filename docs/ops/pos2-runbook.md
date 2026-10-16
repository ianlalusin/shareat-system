# Runbook: the POS v2 server (`pos2.shareat.net`) - T-424

The POS v2 server is a small Next.js server (`apps/pos`, `next start`) that checks money actions the tablet is not trusted to check:
refunds, wrong-tender corrections, voiding an unpaid table, and (test project only) the analytics port. A manager approves each one with
their ERP v2 PIN. It runs as `shareat-pos.service` on **159.223.46.224** (our production host, never `.78.207`) behind
`https://pos2.shareat.net`. **Nothing here is built on the droplet:** CI builds, the box receives a finished artifact (bible 2.10, DEF-238).

Written by the T-424 lane. **The lane does not apply any of this**; the orchestrator and Ian do (spec Ruling 12).

## 0. What each part needs (in the order to do them)

| # | Step | Who | Done when |
|---|---|---|---|
| 1 | A TEST copy of the POS Firebase project, so the new POS can be tried before the December soak with nothing real at risk | Ian + orchestrator | A Firebase project exists with the POS rules and a few test staff/store docs |
| 2 | DNS: `pos2.shareat.net` A record -> `159.223.46.224` | Ian | `nslookup pos2.shareat.net` answers the droplet |
| 3 | A write key (service-account JSON) for that Firebase project, copied to the box. **Never in the code, never pasted in a chat** | Ian or orchestrator | File exists, `chmod 600`, owner `shareat` |
| 4 | The environment file (section 2) | orchestrator | `systemctl show shareat-pos -p EnvironmentFiles` lists it |
| 5 | The Caddy route (section 3) | orchestrator | `curl -s -o /dev/null -w '%{http_code}' https://pos2.shareat.net/api/pos2/refunds` answers 405 (GET) |
| 6 | The unit (section 4) and the `deploy.yml` change (section 6) | orchestrator | first start (section 5) is healthy |
| 7 | Migration **0202** (`pos_terminal_links`) is on the database | the normal deploy | `select to_regclass('pos_terminal_links')` is not null |
| 8 | Each store manager has an ERP PIN (Staff page) AND the permission "approve a POS refund or correction" at their store (`approve_pos_correction`), which an ADMINISTRATOR grants (the access-defaults grid or a hand grant); it is NOT given by default. Administrators hold it implicitly | Ian | A manager's PIN approves a test refund |
| 9 | Each POS v2 tablet is registered (section 7) | an administrator | The tablet's approvals stop saying "not registered" |

## 1. Pointing the APK at the server
The APK keeps calling v1 (`NEXT_PUBLIC_API_BASE`, `https://app.shareat.net`) for loyalty, PINs and the rest. Only `/api/pos2/*` goes to
`NEXT_PUBLIC_POS2_API_BASE` (default `https://pos2.shareat.net`). The server answers CORS for the one origin `https://localhost` (the APK)
and no other. The APK's Firebase project and the server's service-account project **must be the same**: the server rejects a sign-in
token from any other project (401), so a mismatch shows up as "Sign in again" on the first refund.

Test-project builds only: set `NEXT_PUBLIC_POS2_ANALYTICS=1` so sale and void analytics go to `/api/pos2/analytics/apply-delta` (the test
project has no v1 server or reconcile cron). A production build leaves it unset and keeps calling v1's endpoint until the parity test
(`apps/pos/src/server/__tests__/apply-delta.test.ts`) has been green and the orchestrator flips it.

## 2. Environment file
`/srv/shareat-shared/pos2.env` (persistent, never shipped, mode 600, owner `shareat`). Three values, all required:

```
POS_FIREBASE_SA_KEY_FILE=/srv/shareat-shared/pos2-firebase-key.json
DATABASE_URL=<the same connection string the ERP uses (the RLS-enforcing app role), from /srv/shareat-shared/.env.local>
POS_ORG_ID=<the ERP organisation id (uuid)>
```
- `POS_ORG_ID` is a third setting beyond the spec's two: the server is single-organisation by design and never searches across organisations
  to find one. Get it with `select id, name from organizations;` (read only).
- If any value is missing or blank the server answers **503 "POS server is not configured"** to every pos2 route. It does not crash.
- Never put these in a `NEXT_PUBLIC_` variable (a repo test fails if anything does).

## 3. Caddy route
Add a site block beside the ERP's (the ERP's Caddyfile is installed by `provision.sh`; the lane does not touch it):

```
pos2.shareat.net {
    encode zstd gzip
    request_body {
        max_size 1MB
    }
    reverse_proxy 127.0.0.1:9009
}
```
Port **9009** is POS v2's alone (`next start -p 9009 -H 127.0.0.1`); Caddy is the only public listener. Reload with `sudo systemctl reload caddy`.

## 4. The unit
`docs/ops/shareat-pos.service` (T-417) already runs `npm run start` in `/srv/shareat/apps/pos` with `MemoryMax=768M`. Install it as in
`docs/ops/README.md`, and add one line under `[Service]` so it reads the file from section 2:

```
EnvironmentFile=/srv/shareat-shared/pos2.env
```
`sudo systemctl daemon-reload && sudo systemctl enable --now shareat-pos`. Log: `/var/log/shareat/pos.log` (create the file, owner `shareat`).
The server logs an error line (never the request body, never a PIN) on an unexpected failure.

## 5. First start and the memory check
1. `systemctl is-active shareat-pos` -> `active`; `journalctl -u shareat-pos -n 30` shows no crash loop.
2. `curl -s -X POST https://pos2.shareat.net/api/pos2/refunds -H 'content-type: application/json' -d '{}'` -> `401` with "Sign in again to continue."
   (503 "POS server is not configured" means section 2 is incomplete).
3. Memory: `systemctl show shareat-pos -p MemoryCurrent` right after start, again after a few refunds and after an hour. It must stay well under the
   768 MB cap and the ERP must not slow down (`systemctl show shareat-erp -p MemoryCurrent`). If POS climbs, stop it and tell the lane: the ERP comes first.
4. Try one refund on the TEST project with a test tablet and a manager PIN (section 7 first). Then run the detector (section 8).

## 6. `deploy.yml` change - PROPOSAL ONLY (the lane does not edit it)
Today `deploy.yml` ships one artifact built from `apps/erp`. To ship POS v2 beside it, in the same workflow:
1. After the ERP build: `npm run build -w @shareat/pos` (CI only; **never on the droplet**). Do NOT run `build:cap` here.
2. Add to the artifact `PATHS`: `apps/pos/.next apps/pos/package.json apps/pos/next.config.mjs apps/pos/public`. The `scripts`, `packages` and `node_modules`
   entries are already shipped; `firebase-admin` is already in `node_modules` (the ERP uses it).
3. After the ERP restart step: `sudo /usr/bin/systemctl restart shareat-pos.service` (add it to the `shareat` user's sudoers entry beside `shareat-erp`).
4. In "Confirm the app is up": also `curl -fsS http://127.0.0.1:9009/` (POS is up) and `curl -s -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:9009/api/pos2/refunds -d '{}'` -> `401`.
5. Keep the APK build separate (`npm run build:cap -w @shareat/pos`): it stashes `src/app/api` and `src/middleware.ts`, so `out/` holds no server code.
Migration 0202 rides the existing migrate step; no extra step.

## 7. Registering a tablet (once per tablet; again after a re-install)
A wrong manager PIN is charged to the TABLET's own bucket (5 wrong tries per 24 hours per tablet; the store's sign-in budget is never touched), so
every tablet is an ERP **terminal person** AND is linked to its **device id**.
1. The tablet has a terminal person: `npm run provision-terminal -- --store=<CODE> --uid=<firebase uid> --confirm` (existing step; skip if the store's
   tablet already has one). Note the "terminal person id" it prints.
2. On the tablet: **Settings > Terminal > device id > Copy**.
3. An **administrator** links them (capability `provision_clock_terminal`; audited as `pos_terminal_link.provision`; the store's previous link is revoked):
   `npm run provision-terminal -- --store=<CODE> --link-pos-device=<device uuid> --terminal-no=<n> --terminal-person=<id> --admin=<admin person id> --confirm`
   (without `--confirm` it prints the plan and writes nothing).
4. A **re-install** makes a new device id. Until step 3 is repeated with the new id, approvals say "This tablet is not registered for approvals yet.
   Ask an administrator to register it."
5. If a tablet is capped (5 wrong PINs in a day) its message tells the person to go to the store manager. The cap lifts itself after 24 hours, or an
   administrator clears it in ERP (the T-416 action, `manage_users`, on the terminal person's record). A page where a STORE MANAGER can clear it is
   an ERP-side follow-up (the spec asked for it; it is `apps/erp`, outside this lane).

## 8. The detector (read-only, run by a person)
`POS_FIREBASE_SA_KEY_FILE=<key file> node apps/pos/scripts/pos2-audit.mjs --from=20261001 --to=20261016 [--store=<POS store id>]`
Prints, per store and day, COUNTS and RECEIPT NUMBERS only: refunds without an approver, refunds without a receipt-number record, payment conversions not
made by POS v2, and POS v2 corrections that v1 has since voided. Exit 0 = clean, 2 = something listed. It only ever reads.

## 9. What this does NOT protect (until v1 retires at P2)
POS v2 gates its OWN refund, correction and void actions. v1's server is still live and Firestore rules are still v1's loose ones (DEF-652), so while v1
runs: `/api/analytics/payment-conversion` lets any cashier create or void a conversion without a PIN; a refund receipt forged in Firestore plus a call to v1's
`apply-delta 'refund'` lowers `totalGross`; the parent receipt's `refundedQtys` is client-writable (the v2 server counts real refund receipts instead). The
detector in section 8 makes forged or unapproved records visible; it does not stop them.

## 10. Type contract (for developers)
`apps/pos` is typechecked with T-422 ruling 8's looser flags, and imports `@shareat/auth` / `@shareat/db` only inside `src/server/pos2/deps.ts`. That file is
checked against the real packages by `npx tsc -p apps/pos/tsconfig.json --noEmit`, which loads their source too (`packages/db/src/repo/separations.ts` carries a
type-only `as unknown as` so it compiles under both flag sets).

## 11. Rollback
Stop the unit (`sudo systemctl stop shareat-pos`). The tablets' refund, correction and online-void buttons then say they cannot reach the POS server and change
nothing; sales, offline payment and the offline void are unaffected (they do not use the server). Re-enable v1's own refund path is NOT offered: it is the hole
this task closes.
