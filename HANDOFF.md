# Shareat System — Machine Handoff

**Read this first if you are a Claude Code session starting fresh on a new machine.**
You have no memory of the conversation that produced this repository. Everything you need
is written down. Work through this document top to bottom.

> **Ian:** on the new PC, clone this repo, open Claude Code in it, and type **`/handoff`**
> (or just say *"read HANDOFF.md and continue"*).

---

## 0. The 60-second orientation

**Shareat System is an accounting-correctness rebuild of an existing production ERP.**

The existing system (`ERP-rebuild`, live, in daily use by a Philippine restaurant business)
is backed by Firestore. Discovery found its accounting is structurally broken: **it has no
nominal ledger.** Revenue and expense are never posted as journal legs, a single-leg entry
is treated as "trivially balanced", and the income statement is a hand-maintained scan
list. Most other defects are downstream of that.

Shareat System re-platforms it onto **PostgreSQL** with real double-entry bookkeeping, keeping
Firebase only as an offline edge cache for clock terminals.

**`PROJECT_BIBLE.md` is the authority on this project.** Read it in full before doing
anything. It outranks your own preferences, any habit carried over from the old codebase,
and anything in this file. It carries 67 logged decisions, the ten accounting invariants,
and the landmines that must never be repeated.

**Three rules you must not break, ever:**

1. **`ERP-rebuild` is READ-ONLY.** It is live, it is owned by someone else. Never modify
   it, never branch it, never run `git` in it. Read it for reference only.
2. **NEVER BUILD ON THE PRODUCTION DROPLET.** No `next build`, no compile step, on
   `159.223.78.207`. It has 4 GB RAM and runs the app; a build OOMs it. Builds run in CI.
3. **Never touch `webapps\inactive projects`** if it exists on this machine. Retired work.

---

## 1. Install the toolchain

Check what is already present before installing anything:

```bash
git --version
node --version      # need 20+; CI uses 22
npm --version
gh --version        # GitHub CLI — optional but useful
```

Install what is missing (Windows, via winget):

```bash
winget install --id Git.Git -e
winget install --id OpenJS.NodeJS.LTS -e
winget install --id GitHub.cli -e
```

Then authenticate GitHub CLI (Ian does this, interactively):

```bash
gh auth login
```

---

## 2. Set up the workspace

**Convention: all repos live side by side in a `webapps` folder.** Keep this layout —
paths in the docs assume it.

```
C:\Users\<you>\webapps\
    Shareat System\           ← this repo (the work)
    ERP-rebuild\     ← reference only, READ-ONLY
```

### 2a. Clone this repo

```bash
mkdir -p ~/webapps && cd ~/webapps
git clone https://github.com/ianlalusin/Shareat System.git
cd Shareat System
```

### 2b. Clone the reference repo — REQUIRED

**You cannot do this work without ERP-rebuild present.** Every discovery document cites
`file:LINE` references into it, Phase 1 needs its journal builders and chart of accounts,
and the ETL reads its data model. Note the repo is named **`studio`**, not `ERP-rebuild`,
and the working branch is **`upgrade-next16`**, not `main`:

```bash
cd ~/webapps
git clone https://github.com/ianlalusin/studio.git ERP-rebuild
cd ERP-rebuild
git checkout upgrade-next16
```

> ⚠️ **Do not run `npm install` in ERP-rebuild, do not start its dev server, do not
> modify a single file.** You are cloning it to *read* it. It is a live production system
> maintained by someone else.

The parts you will actually read:

| Path | Why |
|---|---|
| `src/lib/financial/journal/builders/` | Pure journal builders — Phase 1 reuses these behind an adapter |
| `src/lib/financial/ACCOUNTING_BLUEPRINT.md` | The stated accounting intent |
| `AGENTS/ERP Guardian/SCHEMA_MAP.md` | 1,000-line Firestore schema map |
| `AGENTS/ERP Guardian/OPEN_CONCERNS.md` | Known defects, 951 lines |
| `AGENTS/ERP Guardian/DECISION_LOG.md` | Why things are the way they are |
| `docs/MARIADB_REBUILD_PLAN.md` | A prior relational-rebuild plan; Shareat System adopts most of it |
| `src/lib/actions/*.actions.ts` | 144 modules of business logic to port |

---

## 3. Install PostgreSQL

> **EDB no longer ships Windows installers.** The postgresql.org download table shows
> "Not supported" for every Windows row. Use `winget`; the package is published by the
> PostgreSQL Global Development Group.

### 3a. The version is **18** — already decided

Local, CI, and production must all be the **same major version**, so a query that works
in dev cannot fail elsewhere. The project is pinned to **PostgreSQL 18**: CI runs
`postgres:18` (`.github/workflows/ci.yml`), bible §4.1 specifies 18, and DigitalOcean
Managed Postgres supports 18. Do not install 16 or 17.

The deciding reason for 18 is **native `uuidv7()`** — bible §4.2 rule 1 wants v7 UUIDs for
primary keys, and on 16 that needs an extension or app-side generation.

When the DigitalOcean Managed cluster is created (§6 Task 2), select **18** there too.
Changing the project's major version is a bible amendment (§14), not a setup-time
choice. *(See bible §13 row 70, which supersedes rows 69 and the original "likely 17".)*

### 3b. Install it

```bash
winget install --id PostgreSQL.PostgreSQL.18 -e --interactive
```

`--interactive` opens the wizard, which matters — you set the port and password there
rather than passing a password on a command line into shell history.

**In the wizard:**

| Setting | Value |
|---|---|
| **Port** | **`5435`** ← *not* the default 5432, and *not* 5433 (already bound by another project's container on this machine). Deliberate: nothing else is disturbed |
| Password | For the `postgres` superuser. Ian keeps this; it goes in `.env.local` |
| Components | PostgreSQL Server + Command Line Tools (pgAdmin optional) |
| Stack Builder | Skip |

**Verify in a NEW terminal** (PATH changes need a fresh shell):

```bash
psql --version
```

If not found, add `C:\Program Files\PostgreSQL\18\bin` to PATH and reopen the terminal.

**Fallbacks if winget misbehaves:** Docker (`docker run -d --name shareat-system-pg -e POSTGRES_PASSWORD=... -p 5435:5432 postgres:18`)
or WSL2 Ubuntu (`sudo apt install postgresql-17`). Linux builds are still published.

### 3c. Create the databases

```bash
psql -U postgres -p 5435 -c "CREATE DATABASE shareat_dev;"
psql -U postgres -p 5435 -c "CREATE DATABASE shareat_test;"
```

`shareat_test` is **truncated between test runs**. The integration-test guard refuses any
database whose name lacks `_test`, so this naming is load-bearing.

---

## 4. Configure and verify

```bash
cd ~/webapps/shareat-system
cp .env.example .env.local
```

Edit `.env.local`. **`.env.example` is the full contract** — every variable is documented
there, and startup fails loudly with a readable list if any required one is missing
(this is deliberate; see bible §7 rule 9).

Minimum to get running locally:

```
DATABASE_URL=postgresql://postgres:<password>@localhost:5435/shareat_dev
TEST_DATABASE_URL=postgresql://postgres:<password>@localhost:5435/shareat_test
SESSION_SECRET=<generate: openssl rand -base64 48>
```

Firebase values can stay blank until the auth bridge is wired in Phase 0 T-006.

> **Never commit `.env.local`.** It is gitignored. Never paste secrets into chat.

### Verify everything works

```bash
npm ci
npm run typecheck          # must be clean
npm run test               # 32 unit tests must pass
npm run test:integration   # needs shareat_test to exist
npm run build              # must succeed
```

Then run it:

```bash
npm run dev                # http://localhost:9008
```

Check `http://localhost:9008/api/health` — it should report the database reachable.

> **Port 9008 is reserved for Shareat System.** Other repos own 9002–9007 and 8000. Never pass a
> different `-p`.
> **Stop the dev server before `npm run build`** — the build overwrites the `.next` the
> dev server is serving, producing unstyled pages and phantom errors on untouched files.

---

## 5. Where the project actually stands

### Done — Phase 0 scaffold, CI green

Next.js 16 + TypeScript + Tailwind on 9008 · Drizzle + forward-only migration runner ·
Vitest split into unit and integration projects · GitHub Actions running typecheck, unit,
migrations, integration against a real Postgres, and build — **all passing**.

Four foundation modules encoding v1's worst landmines as code:

| Module | What it prevents |
|---|---|
| `src/lib/money.ts` | v1 stored every peso as a JS float. Integer centavos behind a string type; `0.1 + 0.2` sums to exactly `0.30`; `allocate()` never loses a centavo; zero is a value, not "unset" |
| `src/lib/datetime.ts` | v1 had four date idioms, one unpinned, putting PH times 8h behind on the server. One `Asia/Manila` helper, one business-day definition |
| `src/lib/env.ts` | v1 shipped a deploy with blank env vars; its passcode secret fell back to a public value and failed OPEN. Fail-closed, no defaults on secrets |
| `src/lib/logger.ts` | Silent failure is v1's defining pathology. Structured, redacting, with `jobResult()` so a background job can never report a bare "done" |

### Next — Phase 1: the accounting spine

Read **`docs/plans/phase-1-accounting-spine.md`**. It is fully specified: chart of
accounts, schema, posting engine, the ten invariants, reporting views, the ETL, and 16
sequenced tasks (T-101 … T-116).

**Start with T-101** (core schema) and **T-102** (chart of accounts seed). The chart is
already aligned and signed off by Ian — see `docs/decisions/COA-ALIGNMENT.md`.

### Read these before writing code

| Document | What it gives you |
|---|---|
| **`PROJECT_BIBLE.md`** | **The authority.** Read fully. |
| `docs/BACKEND-ORIENTATION.md` | How the layers fit; a traced request end to end |
| `docs/plans/phase-1-accounting-spine.md` | What to build next |
| `docs/decisions/COA-ALIGNMENT.md` | The chart of accounts, mapped from v1 and approved |
| `docs/decisions/ADR-002-infrastructure-and-auth.md` | Hosting, database, auth |
| `docs/discovery/01…08` | Eight reports on the existing system |

---

## 6. Ian's outstanding tasks

Tracked in `docs/IAN-SETUP-CHECKLIST.md`. **None were done before this handoff** — the
new machine starts from zero.

| | Task | Blocks |
|---|---|---|
| ☐ 1 | Install PostgreSQL locally on port 5435 (§3) | Local dev and integration tests |
| ☐ 2 | Create the DO Managed Postgres (SGP1, same VPC as the droplet, trusted source = droplet) | Production only — **not** Phase 1 work |
| ☐ 3 | Report what is running on the droplet | Planning its second life |
| ☐ 4 | Optionally install + authenticate `doctl` (Ian pastes the token; the agent never sees it) | Nothing — console works too |

**Only Task 1 blocks development.** Phase 1 is schema and business logic; it needs a local
Postgres, not a cloud one.

---

## 7. What did NOT come across from the old machine

Be aware of these gaps — do not assume the previous environment:

- **Global `~/.claude/CLAUDE.md`** (workspace conventions, the reserved-port table) is
  machine-local. Ian may want to copy it. The essentials are in this file and in the bible.
- **Persistent agent memory** from the old machine is gone. This repo's documents are the
  memory — that is exactly why so much was written down.
- **`node_modules`** — run `npm ci`.
- **`.env.local`** — never committed. Recreate it from `.env.example` (§4).
- **Other repos** in the old `webapps` folder are unrelated to Shareat System.

---

## 8. How work gets done here

From bible §3 — this is not optional:

- **Opus plans, Sonnet implements.** No Sonnet agent starts without a written task spec
  in `docs/tasks/`. No plan is written without discovery evidence behind it.
- **Ian states WHAT is needed; the agent decides HOW** (§0.1). A literal reading of an
  instruction is not automatically the correct execution of it.
- **Brainstorm before executing** (§0.2) — name the industry-standard pattern first.
  Boring and standard beats clever and bespoke.
- **Push back** (§0.4). Tell Ian if scope is too large, a decision was wrong, or something
  should not be built. Explicit permission, therefore an obligation.
- **The four verbs** (§1.2): duplicate what's good, correct what's wrong, add what's
  missing, delete what's not needed and redundant.

**Definition of done** (§9): typecheck clean · unit tests pass · integration tests pass
against real Postgres · smoketested in the running app · build succeeds (dev server
stopped first) · self-reviewed · committed · bible amended if a decision was made.

---

## 9. Your first actions on the new machine

1. Read **`PROJECT_BIBLE.md`** in full. Do not skip it.
2. Confirm the toolchain (§1) and that **both repos** are cloned side by side (§2).
3. Walk Ian through installing PostgreSQL (§3) — this is the one thing that blocks work.
4. Create `.env.local` and run the verification suite (§4). **Report the actual results**,
   including anything that fails.
5. Read `docs/plans/phase-1-accounting-spine.md`.
6. Write the task spec for **T-101** (core schema) into `docs/tasks/`, following the
   format in bible §3.3, and confirm the approach with Ian before implementing.

Report honestly. If a step fails, say so with the output — do not paper over it. Silent
failure is the specific pathology this entire project exists to eliminate.
