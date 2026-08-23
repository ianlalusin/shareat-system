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
of the ERPNext work and may be useful as a reference or data source during ERPv2's
migration. Plan:

- Postgres backups go to a **separate prefix** (`postgres/`) or a dedicated bucket — never
  interleaved with the Frappe archive.
- **No lifecycle/expiry rule** that could silently age out the Frappe objects.
- Revisit deleting them only once ERPv2 is cut over and reconciled, and only on Ian's
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

| Service | Role in ERPv2 | Change |
|---|---|---|
| **Firebase Auth** | Identity provider | None for users |
| **Firebase Storage** | Receipt photos, proof images, exports. **Postgres stores the path, never the bytes** | Uploads brokered server-side after `authorize()` — closes the "any signed-in user can write to any store's folder" gap |
| **Firestore** | **Hot lane only** — mirror + inbox for offline clock terminals (§5) | Shrinks dramatically. ~90 collections → a handful. Rules go from 523 lines to ~30 |
| **App Hosting** | Runs the Next.js app | None |
| **Cloud Scheduler** | The 9 cron jobs | None — same pattern, pointed at ERPv2 routes |

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
that reach **production** Firestore. ERPv2 does not repeat that: local points at local.

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
   Confirm nothing else is running on it first.
3. **Same GCP project as ERP-rebuild, or a new one?** *Recommend a **new** project* —
   clean IAM boundary, no chance of ERPv2 work touching v1's resources, and a separate bill
   line so you can see what v2 actually costs. Firebase Auth users can be shared across
   projects, but that needs checking before committing.
4. **Confirm Firebase Auth stays** as the identity provider (recommended).
