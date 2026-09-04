# ADR-002 — Infrastructure, hosting, and auth

**Status:** ✅ **ACCEPTED — Option B**, chosen by Ian 2026-08-22
**Date:** 2026-08-22
**Question:** Where does the database live, what happens to auth, and what actually changes
about how this runs?

---

## The short version

**Almost nothing about your infrastructure changes.** You keep Firebase App Hosting,
Firebase Auth, Firebase Storage, Cloud Scheduler, and the same GCP project. The only new
component is a **managed PostgreSQL instance**, and the only thing that *leaves* is
Firestore's role as the database.

```
                    ┌─────────────────────────────────────────┐
                    │  Firebase App Hosting  (Next.js, as now) │
                    └───────────────┬─────────────────────────┘
                                    │
        ┌───────────────┬───────────┼───────────────┬──────────────────┐
        │               │           │               │                  │
   Firebase Auth   Postgres    Firebase Storage  Firestore      Cloud Scheduler
   (who you are)   ★ NEW ★     (receipt photos,  (hot lane      (9 cron jobs,
                   SYSTEM OF     proof images)     ONLY, tiny)    unchanged)
                   RECORD
                   (host TBD — see §1)
```

---

## 1. The database — REVISED 2026-08-22 after Ian challenged the cost

**The first draft recommended Cloud SQL and skipped two better-fitting options.** Ian
pushed back on cost and supplied real specs, which changed the analysis.

### The actual assets

| Asset | Spec |
|---|---|
| **SharEat-Droplet** | SGP1 (Singapore) · **4 GB RAM · 80 GB disk** · `159.223.78.207` · ~$20/mo, already paid |
| **Spaces bucket** | `shareat-erp-backups` · SGP1 · 544 items / 1.74 GiB · **already in active use** |

Two facts this changes:

1. **4 GB / 80 GB is genuinely adequate** for a 7-store ERP's Postgres. Transactional data
   for several years is single-digit GB. This is not a cramped box — and it frees up
   substantially once Frappe/MariaDB is retired off it.
2. **The backup destination already exists, in the same region.** The strongest argument
   against self-hosting was "you would have to build backup infrastructure." Spaces is
   already there and already used, so pgBackRest/WAL-G has somewhere to ship to on day one.

### The decisive constraint: co-location, not cloud brand

Whatever runs the app must reach the database **privately**. Mixing clouds breaks that:
Firebase App Hosting has **no static egress IP** by default, so a DO-hosted database would
have to either accept connections from the open internet or sit behind a Cloud NAT
workaround. Neither is acceptable for the accounting system of record.

**So the app and the database must live in the same place.** That single constraint
collapses the option space.

### A risk that turned out lower than assumed

**ERP downtime does not stop the restaurants trading.** POS and the customer app are
separate systems on Firebase and keep running independently. An ERP outage is back-office
pain, not lost revenue.

That materially lowers the availability requirement and argues against over-engineering
for HA. It does **not** lower the *durability* requirement — losing the books is
catastrophic regardless of uptime.

### The three real options

| | New spend | Backups | Private DB | Ops burden |
|---|---|---|---|---|
| **A — Self-host Postgres + app on the droplet** | **$0** | You build (to Spaces) | Yes, localhost/VPC | Patching, disk, restore drills |
| **B — DO Managed Postgres + app on the droplet** ★ | ~$15/mo | **Managed** | Yes, private VPC | Minimal |
| **C — Cloud SQL + Firebase App Hosting** | ~$25–40/mo | **Managed, PITR** | Yes, private IP | Minimal |

### ✅ DECIDED: Option B — Ian, 2026-08-22

**DO Managed Postgres + the app on the existing SharEat-Droplet.** Both in SGP1, same
private VPC. New spend ~$15/month; the droplet is already paid for.

**Recommended: B.** It uses the box already paid for, keeps app and database on the same
private VPC, and spends ~$15/month to remove the one burden that must never be skipped —
backups. Cost delta over self-hosting is roughly a coffee a week for not owning backup
engineering, patching, and restore verification of the system holding payroll and
statutory records.

**A is legitimate**, not reckless, given Spaces already exists — but only with the
non-negotiables below actually built and running, not intended.

**C is now the weakest fit**: most new spend, and its advantage (private IP, managed PITR)
is matched by B at half the cost using hardware already owned.

### If A is chosen — the non-negotiables

These are deliverables, not good intentions. Without all six, A is not acceptable for an
accounting system of record:

1. **pgBackRest or WAL-G shipping to `shareat-erp-backups`**, with WAL archiving for
   point-in-time recovery — not just nightly dumps.
2. **A scheduled, automated restore drill** — restore to a temporary droplet, verify the
   trial balance ties, tear down. Monthly. *An untested backup is not a backup* (§15.8).
3. **Alerting on backup failure** — a silent backup failure is the worst possible state.
4. **Disk and memory monitoring** with alerts. 80 GB is ample, but a full disk stops
   Postgres dead.
5. **Unattended security upgrades** for the OS.
6. **Postgres bound to localhost or the private VPC interface only.** Never a public
   listener. DO cloud firewall in front.

### 🚫 Build discipline — promoted to a non-negotiable

**NEVER BUILD ON THE DROPLET.** Now bible §2 rule 10 and §8 Rule 1, and surfaced in
`CLAUDE.md` so every agent session sees it without reading the full bible.

The droplet has 4 GB RAM and runs the application. A Next.js build peaks past what is free
there and **OOMs the box** — an outage, not a failed command. Builds run in CI (GitHub
Actions); the droplet receives a finished artifact only. **Build once, deploy many; the
production host is not a build machine.**

### The Spaces bucket — confirmed contents

Ian, 2026-08-22: `shareat-erp-backups` holds **only Frappe/ERPNext backups**, no other
project.

**Do not delete them when Frappe is retired.** Those backups are the only remaining record
of the ERPNext work and may be useful as a reference or data source during Shareat System's
migration. Plan:

- Postgres backups go to a **separate prefix** (`postgres/`) or a dedicated bucket — never
  interleaved with the Frappe archive.
- **No lifecycle/expiry rule** that could silently age out the Frappe objects.
- Revisit deleting them only once Shareat System is cut over and reconciled, and only on Ian's
  explicit say-so.

## 2. Auth — unchanged for your staff

**Firebase Auth stays.** Nobody re-registers, no passwords reset, the APK Google sign-in
keeps working exactly as it does today.

What changes is only *where permissions live*:

```
  Staff signs in  →  Firebase Auth issues an ID token   ("who are you")
                          │
                          ▼
  Server verifies token with Firebase Admin SDK
                          │
                          ▼
  Look up the person row in Postgres  →  roles + permissions   ("what may you do")
```

**Firebase answers identity. Postgres answers authority.** Today both live in Firestore,
which is why role checks and data live in the same permissive rules layer.

### Why not move auth to Postgres too

It would be pure risk for no gain right now. Accounts work, Google sign-in on the APK
works, password reset and verification are handled. Auth migration is a high-blast-radius
change with zero accounting benefit. It stays cleanly separable if you ever want it later.

### What *does* change: shared-terminal PIN login

The local-user PIN flow gets fixed (bible §7.1). Today the "acting as" identity is a
**client-supplied parameter** on ~24 server actions with no server-side verification — so
attribution on approvals, charges, and counts rests on a value the browser sends.

In v2, a PIN check **issues a real signed session token**, short-lived and bound to the
device and store. The server reads the actor from that token and never accepts it as an
argument. This is a precondition for every self-dealing control and for trusting payroll
figures derived from punches.

---

## 3. What each Firebase service keeps doing

| Service | Role in Shareat System | Change |
|---|---|---|
| **Firebase Auth** | Identity provider | None for users |
| **Firebase Storage** | Receipt photos, proof images, exports. **Postgres stores the path, never the bytes** | Uploads brokered server-side after `authorize()` — closes the "any signed-in user can write to any store's folder" gap |
| **Firestore** | **Hot lane only** — mirror + inbox for offline clock terminals (§5) | Shrinks dramatically. ~90 collections → a handful. Rules go from 523 lines to ~30 |
| **App Hosting** | Runs the Next.js app | None |
| **Cloud Scheduler** | The 9 cron jobs | None — same pattern, pointed at Shareat System routes |

---

## 4. Local development

| | |
|---|---|
| **Postgres** | Native install, **port 5435** (a non-default port, so no other Postgres on the machine is disturbed; 5433 was the original pick and proved to be taken — see bible §13 row 68). Docker optional — Docker Desktop/WSL2 is flaky on this machine, so native is the safer default |
| **App** | `npm run dev` on **port 9008** |
| **Auth** | Points at the real Firebase project, same as v1 dev does today |
| **Migrations** | Always applied to local first, then promoted. Forward-only, committed |
| **Data** | Seeded reference data + a sanitised subset. **Never a live production connection from a dev machine** |

That last line is deliberate. v1 currently has service-account credentials in `.env.local`
that reach **production** Firestore. Shareat System does not repeat that: local points at local.

---

## 5. Environments

```
  LOCAL          →  developer machine, local Postgres 5435
  STAGING        →  a Cloud SQL clone of production, spun up when needed
  PRODUCTION     →  Cloud SQL, private IP, PITR enabled
```

**Staging is created by cloning production**, which Cloud SQL supports directly. That means
you only pay for it while it exists, and — importantly — **the ETL dress rehearsal runs
against a clone, never against production**. Migration rehearsal on real data with zero
risk to real data.

---

## 6. During the transition (Phases 1–8)

Both systems run side by side (Strangler Fig, §15.3):

- **v1 keeps running, untouched**, serving everything not yet migrated. It is owned by
  someone else (§1.2a) and we do not modify it.
- **v2 runs alongside** on its own hosting, with its own database.
- **The ETL reads v1's Firestore read-only** to load and reconcile history.
- Modules cut over **one at a time, feature-flagged**, and each can be flipped back with a
  config change.
- Daily reconciliation compares the two while both are live.

No single terrifying switchover night.

---

## 7. Backups and recovery — non-negotiable

- **Automated daily backups + point-in-time recovery** enabled from day one.
- **A restore rehearsed on a schedule**, not assumed. An untested backup is not a backup.
- Retention long enough to cover a statutory period, not just a week.
- Firebase Storage objects (receipt photos) covered by their own retention policy — the
  database holds paths, so a lost bucket means lost evidence even with a perfect DB backup.

---

## 8. What Ian needs to decide

1. **Cloud SQL, or start free on Neon?** Cloud SQL recommended for the private IP and
   built-in PITR. Neon is a legitimate zero-cost start if you would rather defer spend —
   and it is migratable later, since it is the same Postgres.
2. **Decommission the DigitalOcean droplet** once Frappe is retired? It stops a bill.
   Confirm nothing else is running on it first. ✅ **RESOLVED 2026-09-04 — reused, not
   decommissioned.** See the Amendment at the bottom of this file.
3. **Same GCP project as ERP-rebuild, or a new one?** *Recommend a **new** project* —
   clean IAM boundary, no chance of Shareat System work touching v1's resources, and a separate bill
   line so you can see what v2 actually costs. Firebase Auth users can be shared across
   projects, but that needs checking before committing.
4. **Confirm Firebase Auth stays** as the identity provider (recommended).

---

## Amendment — 2026-09-04: droplet reuse at cutover, resolving §8 item 2

**Ian, 2026-09-04, on a fresh session:** *"i dont want to spend more is it ok if i build the
whole system try it prepare it for cutover locally then when time to move i will retire frappe
offload it then load my new project to my DO?"*

**✅ Decided: yes.** No second droplet, no spend before cutover. Closes §8 item 2.

### The sequence

| Phase | What happens | Where | Cost |
|---|---|---|---|
| **Now → cutover** | Build and test Shareat System entirely | Local machine — Postgres 5435, app on 9008 (§4) | $0, zero risk to the live droplet |
| **At cutover** | Retire the Frappe/ERPNext stack, reclaim the droplet, deploy Shareat System onto it | The existing SharEat-Droplet (`159.223.78.207`) | Reuses hardware already paid for |

**Confirmed live on the droplet 2026-09-04** (read-only check, nothing changed): 2 vCPU / 3.8 GB
RAM, 1.8 GB used / ~2 GB free / 392 MB already in swap; 77 GB disk, 20 GB used. 11
`erpnext_prod-*` containers up 4 weeks, plus `pos_archive_db` (the unrelated POS transaction
archive Postgres — already live proof that a Postgres container coexists with the MariaDB stack
here without conflict). The headroom is real but not generous, which is exactly why this
amendment reuses the box **sequentially** (Frappe retires, then v2 arrives) rather than running
both **in parallel** — a second full database stack alongside a live, mid-cutover ERPNext would
be the wrong risk for the ~$6–12/mo a second droplet would have cost instead.

### Retirement steps, in order — none of this is optional

1. **Confirm with whoever operates Frappe first.** Per §1.2a, `ERP-rebuild` and the Frappe
   migration are both "actively owned by someone else alongside" Ian. Retiring Frappe is not a
   unilateral infra call just because Ian holds root on the box — get sign-off before step 2.
2. **Final backup, verified**: `bench backup --with-files`, confirmed complete, with the existing
   rclone job having shipped it to Spaces (`shareat-erp-backups`, SGP1) before anything is
   stopped.
3. **Never delete the Spaces backups.** Already decided above (§1) — they are the only surviving
   record of the Frappe/ERPNext work. Statutory retention (BIR) runs years, not months. A copy on
   Ian's PC is a *second* copy for convenience, never the *only* copy.
4. **Stop and remove the `erpnext_prod` stack** (`docker compose -p erpnext_prod down`, then
   `docker system prune`) to reclaim the ~13 GB currently held by old images and build cache.
5. **Deploy Shareat System onto the freed droplet** per Option B (§1 above): app on the droplet,
   database managed, both in the same private VPC. Same IP, DNS, and firewall already
   configured — no infrastructure gets rebuilt from scratch.

### ⭐ Recommended, not required: one rehearsal deploy before the real date

Spin up a throwaway droplet for a day, deploy Shareat System to it end-to-end (migrations, SSL,
env vars), confirm it works, destroy it. Costs pennies and means the actual cutover night is not
the first time the deploy process has run for real. Skippable if Ian would rather not spend the
time.

### "Supabase" — false alarm, corrected 2026-09-04

Ian: *"sorry its not supabase my db is postgresql on my laptop."* No drift from §1 after all —
this is exactly the local dev setup §4 already specifies (native Postgres, port 5435). Option B
(DO Managed Postgres + app on the droplet) stands unchanged as the production target for
cutover; "my DO" in the original question meant the droplet the app deploys to, not the database
vendor.

### Not done in this amendment

**`PROJECT_BIBLE.md` §13 is not updated here.** Per the bible's own §14 amendment protocol, only
an Opus planner session may add to the bible's decision log — a Sonnet session reports the
conflict and stops rather than editing it. This ADR carries the decision in full; an Opus session
should add the corresponding §13 row (and resolve the "Supabase" question above) the next time
one runs.

## Amendment — 2026-09-04 (later the same day): superseded — a new droplet now, not reuse at cutover

**The "droplet reuse timing" amendment above no longer reflects what happened.** Minutes after
that amendment was recorded, in a *different* concurrent session, Ian asked: *"can we add another
droplet first so it is separate from the erpnext and i will just retire the whole droplet soon?"*
— the opposite of "no second droplet, reuse the existing one at cutover."

Flagged explicitly to Ian rather than silently picking either version (two of his own sessions had
recorded conflicting decisions about the same piece of infrastructure) — confirmed: **keep the new
droplet.** T-205 (`docs/tasks/205-first-production-deployment.md`) proceeded on that basis and is
now live.

**What actually exists, as of this amendment:**
- A new droplet, `shareat-system-prod` (`159.223.46.224`, SGP1, 2 GB/2 vCPU), dedicated to
  Shareat System — **not** the old `SharEat-Droplet` (`159.223.78.207`).
- DO Managed Postgres `shareat-system-db`, same VPC as the new droplet, trusted source = that
  droplet only.
- The app live at `https://erp2.shareat.net`, deployed via GitHub Actions.

**The old droplet's full retirement is unchanged in substance, only in sequencing**: it still
happens once Frappe/ERPNext and v1 POS are backed up and Shareat System has grown its own
POS/Customer apps (ADR-003, "1 backend for erp and pos and customer app") — it is simply no longer
the thing v2's *first* deployment waits on. `§8 item 2`'s "Confirm nothing else is running on it
first" still applies whenever that retirement is actually scheduled.

Same caveat as the amendment above: `PROJECT_BIBLE.md` §13 is not updated here (§14 amendment
protocol — Opus planner only). Whoever adds the row for the amendment above should fold this one
in with it, or add a second row noting the reversal — both amendments are now part of this file's
history and should stay legible as *sequence*, not be silently edited away.
