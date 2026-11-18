# T-588 — Retire pos2.shareat.net (the old Firebase POS v2 copy)

> **Status:** queued, not started. Owner: BOSS (Ian, 15 Nov 2026: "we are not building anything on pos2.shareat.net from now on").
> **Trigger:** after Lipa is live on `erp2.shareat.net/pos` (the soak is Sat 21 Nov 2026; go-live follows `docs/runbooks/pos-lipa-switch.md`). Not before.
> **Migration:** none. **Touches production:** yes, so every step below needs Ian's yes in chat first.

## Why
Bible row 430 made POS v2 a module of the ERP app (`/pos` in `apps/erp`, on the one Postgres, with the ERP sign-in).
`apps/pos` (the Firebase POS v2 copy) and its own service are now a second thing to patch, build and secure
that nothing new will use. Nothing is built on it from now on; security fixes only until this task closes.

## What exists today (verify each; do not trust this list)
- `apps/pos`: the Firebase-backed POS v2 web app.
- `shareat-pos.service` (systemd) on **159.223.46.224** (the production host, never `159.223.78.207`), port **9009**,
  behind the nginx site for `pos2.shareat.net`.
- The deploy workflow's POS build and restart steps (`.github/workflows/deploy.yml`, the `shareat-pos.service`
  restart and the `:9009/api/pos2/health` probe).
- DNS record for `pos2.shareat.net`.

## Steps (in this order; stop and report at any red)
1. **Confirm nobody uses it.** Read-only, with Ian's approval for production access:
   - nginx access log for `pos2.shareat.net` over the last 14 days: any request that is not a health probe or a bot;
   - `shareat-pos.service` journal: any sign-in, receipt or event post in the same window;
   - paired devices: every active store tablet points at `erp2.shareat.net/pos` (ERP admin, tablets screen), none at pos2.
   If any store or tablet still uses it, stop and tell Ian which one. Do not retire.
2. **Stop the service:** `systemctl stop shareat-pos.service`, then `disable`. Keep the unit file for one week so a
   rollback is one command. Watch the ERP health and the Lipa till for a day.
3. **Remove the nginx site** for `pos2.shareat.net` (disable the symlink, reload nginx), then **remove the DNS record**.
4. **Remove the deploy steps** in a normal PR: the POS web build and the `shareat-pos.service` restart and health probe
   in `.github/workflows/deploy.yml`. No build ever runs on the droplet (DEF-238); this is CI only.
5. **Archive `apps/pos`** per bible row 430: move it out of `apps/` (or tag the last commit and delete the folder; Ian
   picks), drop it from workspace config, and keep the history. Update `AGENTS.md`/`CLAUDE.md` where they list
   `apps/pos` as "reserved" and any census or guard that walks `apps/*`.
6. **Close out:** a bible row recording the retirement date and the rollback state; mark the BOARD line T-588 done;
   delete the unit file after the one-week hold.

## Done when
- No request reaches `pos2.shareat.net`; the name no longer resolves.
- `apps/pos` is gone from the tree, CI is green, and the deploy workflow no longer mentions the POS service.
- ERP, `/pos` at Lipa and every paired tablet are unaffected (checked after step 2 and after step 5).

## Not in scope
POS v1 (`C:\Users\ianla\webapps\POS`): read-only and live until the v2 swap (Ian's ruling of 15 Nov). The tablet APK.
Moving any data: the old copy's Firebase data is not migrated by this task.
