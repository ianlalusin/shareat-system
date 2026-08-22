# Ian's setup checklist — Phase 0

Everything here needs your accounts, your machine, or your credentials. Everything **not**
here, I'm doing.

⚠️ **Never paste a database password, API token, or service-account key into chat.** Put
secrets straight into `.env.local` (gitignored) or GitHub Secrets. When you need to tell me
something worked, say "done" — not the value.

---

## ☐ TASK 1 — Install PostgreSQL 16 locally (~10 min)

Needed so local dev and tests run against a real Postgres, never production.

1. Download the Windows installer: **https://www.postgresql.org/download/windows/**
   (the EDB installer). Pick **PostgreSQL 16**.
2. Run it. During setup:
   - **Port: `5433`** ← *not the default 5432.* This is deliberate, so any existing
     Postgres on your machine is never disturbed.
   - Set a password for the `postgres` superuser and **keep it somewhere safe**.
   - Components: PostgreSQL Server + Command Line Tools. pgAdmin optional.
   - Skip Stack Builder at the end.
3. Verify — open a **new** Git Bash window and run:
   ```bash
   psql --version
   ```
   If that says `command not found`, add PostgreSQL's `bin` folder to your PATH
   (typically `C:\Program Files\PostgreSQL\16\bin`) and reopen the terminal.

**Tell me:** "local postgres done" — I'll create the `erpv2_dev` database and wire it up.

---

## ☐ TASK 2 — Create the DO Managed Postgres (~15 min, ~$15/mo)

1. DigitalOcean Console → **Databases** → **Create Database Cluster**
2. Settings — these matter:

   | Field | Value | Why |
   |---|---|---|
   | Engine | **PostgreSQL 16** | Matches local |
   | Region | **Singapore / SGP1** | **Must match the droplet** or you lose private networking |
   | VPC Network | **the same VPC as SharEat-Droplet** | This is what keeps the DB off the public internet |
   | Plan | Basic — smallest node | Resizes later; start small |
   | Name | `erpv2-db` | |

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

## ☐ TASK 4 — Optional: install `doctl` (~5 min)

Lets me manage DO resources directly instead of handing you console steps.

```bash
winget install --id DigitalOcean.Doctl
```
Then create a token at **DO → API → Generate New Token** (read+write) and run:
```bash
doctl auth init
```
Paste the token **into that prompt only** — not into chat.

Skip this if you'd rather drive the console yourself.

---

## ☐ TASK 5 — Confirm the GitHub repo name

`gh` is already authenticated as **ianlalusin**, so I can create the repo myself. Default
plan: **private** repo named **`ERPv2`**.

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
