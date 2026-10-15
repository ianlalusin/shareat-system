# Handoff prompt — cloud session 2026-10-14 → local agent

Paste everything below the line into a new local Claude Code session at `C:\Users\ianla\webapps\shareat-system`.

---

You are picking up work done in a **cloud** Claude Code session on 2026-10-14. Make local and remote identical first, then orient.

## 1. Sync (do this first, exactly)
```bash
git status                      # must be clean; if not, STOP and tell Ian what is uncommitted
git fetch origin
git checkout claude/pos-v2-feature-planning-1vey06 2>/dev/null || git checkout -b claude/pos-v2-feature-planning-1vey06 origin/claude/pos-v2-feature-planning-1vey06
git pull --ff-only origin claude/pos-v2-feature-planning-1vey06
git log --oneline -4            # top commits should be the T-404 commit and "record Ian's 2026-10-14 … list verbatim"
git diff origin/claude/pos-v2-feature-planning-1vey06 --stat   # must print nothing = identical to remote
```
The branch is based on `main` at `c7cf55a` (PR #24 merge). **No PR has been opened** — Ian decides that.

## 2. What the cloud session did
Ian gave a 31-item feature/feedback list and asked: *is each item already planned, a pivot from what is set up now, and why was it designed that way (previous decision)?*

| File | What |
|---|---|
| `docs/feedback/2026-10-14-ian-raw.md` | Ian's list, **verbatim** |
| `docs/feedback/2026-10-14-ian-feedback-review.md` | ⭐ The answer: every item marked BUILT / PLANNED / NEW / **PIVOT** / FIXED TODAY, citing bible §13 rows, task specs, ADRs, DEFs. Ends with **14 questions for Ian** |
| `docs/tasks/404-ian-2026-10-14-quick-fixes.md` | Spec for the UI-only fixes built today |
| `apps/erp/src/app/ap/suppliers/[id]/page.tsx` | "Blank supplier page" fixed: read-only details card + the supplier's invoices (whole-row clickable) |
| `apps/erp/src/app/admin/stores/page.tsx` | Create form hidden behind an "Open a branch" button; whole row opens the store |
| `apps/erp/src/app/inventory/page.tsx`, `apps/erp/src/app/till/page.tsx` | GL account numbers replaced by words |
| `apps/erp/tests/action-link-sweep.test.ts`, `apps/erp/tests/t384-s3-lock-and-save-guard.test.ts` | Census total 1170→1172; renamed button key |

**Gates in the cloud:** `npm run typecheck` clean; `npm test` 6168 passed / 0 failed. One file,
`apps/erp/tests/t334-slice3-tranche1-input.test.ts`, could not load because the cloud clone was **shallow** (it `git show`s commit
`1a471e6`). **Re-run `npm test` locally**, where that file should pass. Integration tests and a browser check were **not** run in the cloud
(no Postgres there).

## 3. Your first jobs
1. Run the gates locally: `npm run typecheck`, `npm test`. If you want an integration pass, use `npm run test:integration` against local Postgres on **5435**.
2. Start the dev server on **9008**. Look at `/ap/suppliers/<any id>`, `/admin/stores`, `/inventory` and `/till` at 390px and 1280px. Check that the whole row is clickable and that the stores form opens and closes.
3. Read `docs/feedback/2026-10-14-ian-feedback-review.md` → **"Questions for Ian"**. Nothing marked 🔀 PIVOT is built until Ian answers and the Opus planner writes a bible row. These include till ownership, choosing a role at sign-in, the "needs receipt" flag, expense sub-category and convert→slice.
4. Item 6, **attendance**, gets its own dedicated session (Ian's instruction). Do not start it here.

## 4. Ready-to-spec next (no decision needed, all ➕ in the review)
- Whole-row-click sweep: a shared `RowLink` in `components/ui/Table.tsx` across about 75 tables, with a census test. T-258 already decided this.
- Remaining account codes in UI, about 16 files: an `accountLabel(code)` helper.
- `PersonName` helper: 4 pages fall back to a raw UUID (`?? personId`).
- Wire VAT type, VAT amount and the OR flag into the supplier-invoice form. The domain already accepts them; the action drops them.
- Service-charge per-store on/off setting. Needs a hand-authored migration (ADR-012).
- Production: filter slice pickers to meat only, and make cook require a recipe in the form.
- Customer price list: UOM always from the item; stop the free-text unit.
- Gmail wastage ingest (scheduled job, draft records, machine principal).

## 5. Rules to keep in mind (from CLAUDE.md / docs/RULES.md)
Opus plans and Sonnet codes; no code without a spec in `docs/tasks/`. Only the Opus planner edits `PROJECT_BIBLE.md`. Migrations are
hand-authored. Never build on either droplet. The reference repos are read-only. When Ian says "wrap up today's work", run the `wrap-up` skill.
