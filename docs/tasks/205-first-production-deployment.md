# T-205 — Shareat System's first production deployment, and installing the three scheduled jobs

> **Status:** 🚧 **CI-side half built, 2026-09-04. Gates green; nothing deployed yet.** Written
> after `/research-evaluate-propose` on Ian's ask to "install the systemd timers" found the real
> task was much larger: the app has never been deployed anywhere, so there is nothing to point a
> timer at. See `docs/DEFECTS-REGISTER.md` **DEF-153** for a related documentation defect found
> while researching this (bible's infra summary table contradicts its own superseding decision).
> **Gates:** typecheck clean · unit 942/943 (1 pre-existing skip) · integration 79 files / 2117
> tests green (real Postgres) · `npm run build` exit 0 · smoketested on 9008 (`/api/health` and
> `/sign-in` both 200 after the `dotenv`/`tsx` dependency fix). **Not committed — Ian's call.**
> **Cannot go further without Ian**: the deploy workflow, provisioning script and new units are
> all written, but nothing on the droplet exists yet and none of the required GitHub Secrets do
> either — see Phase 0/4 in the plan and the open questions below.
> **Depends on:** ADR-002 §1 (Option B — DO Managed Postgres + the app on its own droplet, both
> SGP1, same VPC), `IAN-SETUP-CHECKLIST.md` §4b (GitHub Actions + a deploy key in Secrets; no
> standing shell access for any human or agent), bible §2.10 / RULES rule 11 (never build on the
> droplet), `docs/ops/README.md` (the three job definitions and their cadence rationale).
> **Blocks:** ADR-007's Oct–Dec 2026 pilot — real staff cannot use v2 until it is reachable.
>
> ⚠️ **2026-09-04, revised mid-task:** Ian decided to stand up a **new droplet dedicated to
> shareat-system**, separate from the old shared `159.223.78.207` (ERPNext + POS archive DB). This
> removes the capacity/port-sharing constraints the first draft of this spec was written against —
> see the updated decisions and open questions below. **The old droplet's eventual full retirement
> is real but is a distant, separate task**, gated on v2 growing its own POS/Customer apps
> (Ian: *"1 backend for erp and pos and customer app... for shareat system"* — ADR-003) and
> migrating everything off the old box first. T-205 does not touch the old droplet at all.

## Why this exists

`docs/ops/shareat-firestore-relay.{service,timer}` and `shareat-attendance-sweep.{service,timer}`
are written and correct, but both assume `/srv/shareat` is a checked-out, built, `shareat`-owned
tree reachable at boot. **None of that exists.** `docs/ops/README.md` itself says so, verified by
direct SSH inspection 2026-09-01. Ian's ask to "install the timers" cannot be executed literally —
there is nothing to install them onto.

**This is not premature work being pulled forward.** ADR-007 commits to running v2 for real with
staff in Oct–Dec 2026. Today is 2026-09-04. Production must exist in roughly four weeks regardless
of how this task is scoped.

## Goal

1. A GitHub Actions workflow that builds the app in CI (never on the droplet — bible §2.10) and
   ships a finished, runnable artifact to shareat-system's own new droplet over SSH, using a
   deploy-only key held in GitHub Secrets (nothing standing, nothing through an agent — checklist
   §4b).
2. The app running under systemd, behind Caddy on standard 80/443 with automatic Let's Encrypt TLS,
   reachable by pilot staff.
3. All four scheduled jobs — firestore-relay, attendance-sweep, and the two new month-end units this
   task must also write — installed, armed (`enable --now`), and verified to have run at least once.

## Scope — files this task may create or modify

**New:**
- `.github/workflows/deploy.yml` — build + ship, gated on the existing `verify` job, triggered on
  push to `main` (Ian's choice — see decisions below)
- `docs/ops/shareat-erp.service` — the web process itself (`next start -p 9008`, `Restart=always`).
  Distinct from the three *job* units; this one is long-running
- `docs/ops/shareat-month-end.service` / `.timer` — does not exist yet; only a table row in
  `docs/ops/README.md:39`. Match the shape of `shareat-attendance-sweep.{service,timer}` exactly:
  same header comment style, same `User=shareat`/`WorkingDirectory=/srv/shareat`, `OnCalendar=*-*-01
  02:00`, `Persistent=true`
- `docs/ops/provision.sh` — one-time, idempotent, reviewable shell script: creates the `shareat`
  user, `/srv/shareat`, `/var/log/shareat` (owned `shareat:shareat`), installs all four unit pairs.
  **Ian runs this. No agent runs it — checklist §4b's principle extends to provisioning, not just
  deploys.**
- `docs/ops/README.md` — **modify**: replace the "never deployed" precondition section with the real
  procedure once it exists; keep the job table

**Modify:**
- `package.json` (root) — move `dotenv` and `tsx` from `devDependencies` to `dependencies`. Both are
  required at runtime (`apps/erp/next.config.js:9` calls `dotenv` on every `next start`, not just
  build; all four job scripts run via `tsx`), which makes bible §8's `npm ci --omit=dev`
  prescription unexecutable as currently written. **Flagged for the bible amendment below — I do
  not amend the bible myself (RULES rule 14).**
- `docs/ops/shareat-firestore-relay.service`, `shareat-attendance-sweep.service` — drop
  `After=postgresql.service` / `Wants=network-online.target` ambiguity around a **local** Postgres;
  the DB is managed and off-box (Option B). Keep `After=network-online.target` only.

**Do not touch:** anything under `packages/domain/`, `packages/db/schema/`, or `apps/erp/src/` —
this task is deploy infrastructure only, no application logic changes. No new migration.

**Explicitly out of scope for this task** (named, not silently dropped):
- Anything on the OLD droplet (`159.223.78.207`) — ERPNext, POS archive DB, its retirement. T-205
  never SSHes there and provision.sh refuses to assume it's the target.
- Building shareat-system's own POS/Customer apps — reserved app slots (`apps/{pos,customer}`)
  exist in the monorepo per ADR-003, but building them is not this task.
- DNS itself — Ian points an A record at the new droplet's IP once it exists; this task's Caddy
  step only configures the droplet side.
- Disk/memory alerting and the monthly restore-drill automation ADR-002 §1 calls non-negotiable for
  Option A. Option B's managed backups cover durability; monitoring is real follow-up work, not
  bundled here.
- Any bible/ADR-002 text correction for DEF-153 — that's an Opus-planner edit (RULES rule 14), this
  task only names the sections needing it.

## Bible amendment needed (flagged, not made)

§8's `npm ci --omit=dev` line (bible line 992) should note the `dotenv`/`tsx` exception once this
task's `package.json` change lands, or be rephrased to `npm ci --omit=dev` **for the packages that
tolerate it** with a pointer to which two do not. Ian/the Opus planner's call on wording.

## Decisions Ian has made

| | Decision | Date |
|---|---|---|
| Droplet | **New, dedicated to shareat-system** — not the old shared 159.223.78.207 | 2026-09-04 |
| Size | 2 GB / 2 vCPU (~$18/mo) — the app + 3 job timers only; DB is off-box either way | 2026-09-04 |
| Exposure | Standard 80/443 with Caddy + automatic Let's Encrypt (no traefik conflict on a fresh box) | 2026-09-04 |
| Old droplet's fate | Retired in full, eventually — once v2 has its own POS/Customer apps and the old box's data is backed up. Separate task, not T-205 | 2026-09-04 |
| Deploy trigger | Auto-deploy on every green push to `main` | 2026-09-04 |
| Provisioning | Ian creates the droplet (doctl/console) and tells Claude the IP; Claude never holds droplet-creation credentials | 2026-09-04 |
| DO Postgres cluster status | Unconfirmed — Ian to run `doctl auth init`, then a read-only `doctl databases list` settles it | 2026-09-04 |

## Open questions blocking Phase 4/5

1. **The new droplet doesn't exist yet.** Needs: region **SGP1** and the **same VPC** as the DO
   Postgres cluster (ADR-002 §1's private-networking constraint is non-negotiable regardless of
   which droplet runs the app) — see the exact `doctl` command below. Once created, Ian tells
   Claude the IP for `DEPLOY_HOST`.
2. **A hostname for Caddy.** No domain for v2 is recorded anywhere in this repo — Ian needs to name
   one and point its DNS A record at the new droplet's IP before `provision.sh <domain>`'s Let's
   Encrypt step can succeed.
3. Confirm the DO cluster's trusted-source setting only allows the new droplet (ADR-002 §1's "never
   a public listener" non-negotiable), once both exist.

## Verification (bible §9's definition of done, applied to infrastructure)

1. `verify` then `deploy` both green in GitHub Actions.
2. App reachable over `https://<the chosen domain>`; a real sign-in; one real page renders against
   the DO cluster — not just "the build succeeded" (bible §9.4).
3. `select count(*) from drizzle.__drizzle_migrations` on production equals the committed migration
   count.
4. `systemctl list-timers` shows populated `NEXT`/`LEFT` for all four units.
5. Each job started once by hand (`systemctl start <unit>`); `journalctl -u <unit>` and a
   `scheduler_runs` row confirm a real run, not just "enabled."
6. `journalctl -u caddy` shows a clean certificate issuance, no ACME errors.

## Report FOR IAN

This task ships CI-side files only in its first pass (workflow, unit files, provisioning script) —
none of it touches any droplet by itself. What's left needs you directly: creating the new droplet
(SGP1, same VPC as the DB, 2GB) and telling Claude the IP, confirming the DO cluster, naming a
domain, generating the deploy key, and setting GitHub Secrets. See `docs/ops/provision.sh`'s own
header before running it.
