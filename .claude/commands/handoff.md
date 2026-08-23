---
description: Orient a fresh session on this machine and continue Shareat System work
---

You are starting fresh on this machine with no memory of prior conversations about this
project. Orient yourself properly before doing anything.

1. **Read `HANDOFF.md` in this repository, in full.** It is the cold-start guide.
2. **Read `PROJECT_BIBLE.md` in full.** It is the authority on this project and outranks
   your own preferences and any habit from the reference codebase.
3. Verify the machine setup, in this order, and report the ACTUAL result of each — never
   assume, never skip, never paper over a failure:
   - toolchain: `git --version`, `node --version`, `npm --version`
   - both repos cloned side by side under a `webapps` folder:
     - this repo (Shareat System)
     - the reference repo, cloned from `https://github.com/ianlalusin/studio.git` into a
       folder named `ERP-rebuild`, on branch `upgrade-next16` — **READ-ONLY, never modify
       it, never run git in it, never npm install in it**
   - PostgreSQL installed and listening on **port 5435** (`psql --version`)
   - `.env.local` exists (create from `.env.example` if not)
   - `npm ci`, `npm run typecheck`, `npm run test`, `npm run build`
4. Tell Ian exactly what is missing and walk him through it. **Installing PostgreSQL is
   usually the blocker** — start there if `psql` is absent.
5. Once verified, read `docs/plans/phase-1-accounting-spine.md` and report where the
   project stands and what the next task is.

Do not start writing feature code until steps 1–4 are done and reported.

Three rules you must never break:
- `ERP-rebuild` is read-only; it is live production owned by someone else.
- Never run a build on the production droplet (`159.223.78.207`) — builds run in CI.
- Port 9008 for dev, 5435 for Postgres. Nothing else.
