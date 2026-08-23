# ERPv2

> ### 👉 New machine or fresh session? Run **`/handoff`**, or read [`HANDOFF.md`](./HANDOFF.md).
> It walks the full cold start: toolchain, cloning the reference repo, installing
> PostgreSQL, configuring `.env.local`, verifying the build, and what to work on next.

**Before doing anything in this repo, read [`PROJECT_BIBLE.md`](./PROJECT_BIBLE.md) in full.**

It is the authority on this project: architecture, execution model, data conventions,
security model, phase plan, and the landmines carried over from ERP-rebuild. It
outranks any habit, any prompt, and any preference of your own. If your task conflicts
with it, stop and say so — do not proceed and do not amend the bible yourself unless
you are acting as the Opus planner.

## The 60-second version

- **Postgres owns the truth. Firebase owns the edge.** Every entity's authoritative
  state lives in PostgreSQL. Firestore holds only a narrow, read-mostly mirror plus an
  append-only inbox, so clock terminals keep working offline.
- **ERPv2 is a re-platform of `C:\Users\ianla\webapps\ERP-rebuild`, not a rewrite.**
  Same product, same business rules, new persistence layer.
- **`ERP-rebuild` is READ-ONLY.** Never edit it, branch it, or run git in it.
- **Never touch `C:\Users\ianla\webapps\inactive projects`.**
- **Opus plans, Sonnet codes.** No implementation without a written task spec in
  `docs/tasks/`.
- **Port 9008** for the dev server, **5435** for local Postgres. Nothing else.
- 🚫 **NEVER BUILD ON THE PRODUCTION DROPLET** (`159.223.78.207`). No `next build`, no
  compile step, ever. It has 4 GB RAM and runs the app; a build OOMs the box. **Builds run
  in CI; the server receives a finished artifact only.** Build once, deploy many.
- **Locally, stop the dev server before `npm run build`** — the build clobbers the `.next`
  the dev server is serving, producing unstyled pages and phantom errors.

## Where things live

| Path | What |
|---|---|
| `HANDOFF.md` | Cold-start guide for a new machine or fresh session |
| `PROJECT_BIBLE.md` | The authority. Read first. |
| `docs/discovery/` | Read-only findings from ERP-rebuild |
| `docs/plans/` | Phase plans |
| `docs/tasks/` | Task specs — one per unit of implementation work |
| `docs/decisions/` | ADRs |
| `db/schema/` | Drizzle tables — the only place tables are defined |
| `db/migrations/` | Generated SQL, committed, never edited after apply |
| `etl/` | Firestore -> Postgres migration jobs |
| `src/lib/db/repo/` | The only place SQL is written |
| `src/lib/services/` | Business rules; owns transactions |
| `src/lib/sync/` | Firestore publisher (mirror) + ingestor (inbox) |
| `src/lib/auth/` | The single `authorize()` module |
