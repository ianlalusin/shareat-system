# Ian's setup checklist — Phase 0

Everything here needs your accounts, your machine, or your credentials. Everything **not**
here, I'm doing.

⚠️ **Never paste a database password, API token, or service-account key into chat.** Put
secrets straight into `.env.local` (gitignored) or GitHub Secrets. When you need to tell me
something worked, say "done" — not the value.

---

## ☐ TASK 1 — Install PostgreSQL locally (~10 min)

> **Corrected 2026-08-22.** The original instruction said to use the EDB installer from
> postgresql.org. **EDB no longer ships Windows installers** — every Windows column on
> that page reads "Not supported". Ian spotted this. Use `winget` instead; the package is
> published by the PostgreSQL Global Development Group itself.

### Do this in order — the version must match production

**1a. The version is already decided: PostgreSQL 18.** No need to check DigitalOcean
first — DO supports 18, CI runs `postgres:18`, and bible §4.1 specifies 18. Local must be
18 so your machine matches the pipeline that gates every commit. The deciding reason is
native `uuidv7()` (bible §4.2 rule 1). When you create the DO cluster in Task 2, pick
**18** there as well.

**1b. Install that same version locally:**

```bash
# if DO offers 17 (most likely)
winget install --id PostgreSQL.PostgreSQL.18 -e --interactive

# if DO's newest is 16
winget install --id PostgreSQL.PostgreSQL.18 -e --interactive
```

`--interactive` matters: it opens the setup wizard so you can set the port and password
yourself, rather than the installer silently defaulting and putting a password on the
command line where it would land in shell history.

**In the wizard:**

| Setting | Value |
|---|---|
| **Port** | **`5435`** ← *not* the default 5432, and *not* 5433 (taken by `amianai-postgres`). Deliberate, so no other Postgres on this machine is disturbed |
| Password | For the `postgres` superuser. Keep it safe; you will put it in `.env.local` |
| Components | PostgreSQL Server + Command Line Tools. pgAdmin optional |
| Stack Builder | Skip at the end |

**1c. Verify** — open a **new** Git Bash window (PATH changes need a fresh shell):

```bash
psql --version
```

If it says `command not found`, add the install's `bin` folder to PATH
(e.g. `C:\Program Files\PostgreSQL\18\bin`) and reopen the terminal.

**Tell me:** "local postgres done, version NN" — I will create the `shareat_dev` and
`shareat_test` databases and wire up `.env.local`.

### Alternatives, if winget gives you trouble

- **Docker** (installed here, v29.6.1): `docker run -d --name shareat-system-pg -e POSTGRES_PASSWORD=... -p 5435:5432 postgres:18`
  Fast, but Docker Desktop/WSL2 has been flaky on this machine before, so it is the fallback rather than the default.
- **WSL2 Ubuntu** (already your default distro): `sudo apt install postgresql-17`.
  Linux builds *are* still published, so this works — it just puts the database behind
  the WSL network boundary, which is one more thing to reason about.

---

## ☐ TASK 2 — Create the DO Managed Postgres (~15 min, ~$15/mo)

1. DigitalOcean Console → **Databases** → **Create Database Cluster**
2. Settings — these matter:

   | Field | Value | Why |
   |---|---|---|
   | Engine | **PostgreSQL 18** | Must match CI and local (bible §13 row 70) |
   | Region | **Singapore / SGP1** | **Must match the droplet** or you lose private networking |
   | VPC Network | **the same VPC as SharEat-Droplet** | This is what keeps the DB off the public internet |
   | Plan | Basic — smallest node | Resizes later; start small |
   | Name | `shareat-system-db` | |

3. After it provisions → **Settings → Trusted Sources** → add **SharEat-Droplet**.
   This restricts connections to that droplet only.
4. Under **Connection Details**, switch the dropdown to **VPC / Private network**.
   Copy that connection string somewhere safe — we'll use it later. **Don't send it to me.**

**Tell me:** "DO database done" plus the **host** and **port** only (never the password).

> Cost check before you confirm: DO shows the monthly price on the create screen. If it's
> materially above ~$15, tell me and we'll revisit — my estimate could be stale.

---

## ☐ TASK 3 — Tell me what's on the droplet (~5 min)

Before we plan its second life, I need to know what's already there. SSH in
(`ssh root@159.223.78.207`) and run:

```bash
systemctl list-units --type=service --state=running --no-pager | head -40
docker ps 2>/dev/null
df -h /
free -m
nginx -v 2>&1; caddy version 2>&1
crontab -l 2>/dev/null
```

**Paste me the output.** It's all non-sensitive. I'm looking for: what Frappe left behind,
whether there's a web server already, how much disk and RAM are actually free, and any
stray cron jobs.

---

## ☐ TASK 4 — Credentials: what I need, and what I must never see

Three DIFFERENT credentials are involved. They are not interchangeable, and I handle
none of them directly.

| Credential | What it is for | How I get access |
|---|---|---|
| **DO API token** | Create/manage the database cluster, trusted sources, read droplet info | **You** authenticate `doctl`. I run `doctl` commands. **I never see the token.** |
| **Spaces access key + secret** | Postgres backups shipping to `shareat-erp-backups` (Phase 0/1) | Goes straight into the backup config on the droplet. Never into the repo, never into chat. |
| **SSH access to the droplet** | Deploying, and reading what is running | Your call — see below |

### 4a. DO API token → install and authenticate `doctl` yourself

```bash
winget install --id DigitalOcean.Doctl
```

Then create a token: **DO Console → API → Tokens → Generate New Token**
- Scopes: **read + write** (needed to create the database cluster)
- **Set an expiry** — 90 days is plenty; it can always be regenerated
- If DO offers granular scopes, limit it to `database` and `droplet`

```bash
doctl auth init
```

**Paste the token into that prompt and nowhere else.** Not into chat, not into a file,
not into a commit. Once `doctl` holds it, I can run commands against your account without
the value ever passing through me.

Verify it worked:
```bash
doctl account get
```

**This is optional.** If you would rather drive the DO console yourself, skip it entirely
and I will hand you console steps instead — nothing in the plan depends on `doctl`.

### 4b. SSH to the droplet — decide later, not now

For Phase 0 I only need the **output** of the commands in Task 3, which you can paste.

Real deploys eventually need either an SSH key I can use, or you running a deploy command.
**Recommendation: neither, long-term.** Deployment should run from **GitHub Actions** with
a deploy key held in GitHub Secrets — so no human and no agent needs standing shell access
to the production box, and every deploy is logged and repeatable. That is the industry
norm and it is also the safest arrangement here.

We can decide this when we get to deployment. It does not block anything now.

---

## ☐ TASK 5 — Confirm the GitHub repo name

`gh` is already authenticated as **ianlalusin**, so I can create the repo myself. Default
plan: **private** repo named **`Shareat System`**.

**Tell me** if you want a different name or visibility. Otherwise I'll proceed with that.

---

## What I'm doing meanwhile — no waiting required

| | Task |
|---|---|
| T-001 | Git init + Next.js 16 / TypeScript / Tailwind scaffold on **port 9008** |
| T-002 | Drizzle ORM + forward-only migration runner |
| T-003 | Fail-closed env validation + committed `.env.example` |
| T-004 | Structured logging, error handling, health endpoint |
| T-005 | Vitest harness (unit + integration against real Postgres) + GitHub Actions CI |
| T-006 | Firebase Auth bridge — verify token server-side, resolve to a `person` row |

Then Phase 1: the accounting spine.

**Only Tasks 1 and 2 block me**, and only when I get to wiring the database. Everything
else in the scaffold proceeds regardless.
