# T-269 — DEF-297 / DEF-298: make the orphan sweep honest, and finish Ian's bootstrap ruling

**Status:** `COMPLETE 2026-09-12` — shipped `9793175`, lane A. DEF-297 and DEF-298 fixed, third bootstrap site routed. ⛔ **Read DEF-299 before wiring the sweep**: it has no caller and never has, so DEF-298 had never fired.

> ⭐ **You found both of these.** T-267 asked you one question — *does the sweep's delete actually
> delete?* — and the answer turned out to be two defects, one of them data loss. This task is
> fixing what that question uncovered.

---

## Goal

The orphaned-file sweep can no longer (a) report a file removed when it removed nothing, or
(b) delete a file's bytes while its database row survives. And the third and last of Ian's three
bootstrap sites stops asking its question on an unprincipalled connection.

## Scope — the only paths you may modify

```
scripts/bootstrap-org.ts                          (ONE line — site 3)
packages/db/src/repo/files.ts                     (deleteFile)
packages/domain/src/files/index.ts                (sweepOrphanedFiles only)
packages/domain/tests/integration/files.test.ts
```

---

## Part 1 — DEF-297: `deleteFile` must be able to tell you it deleted nothing

`packages/db/src/repo/files.ts:101-103` is a bare `tx.delete(...).where(...)` typed
`Promise<void>`. A DELETE matching zero rows is not an error in Postgres, so the caller cannot
distinguish "removed" from "did nothing".

**Contract:** `deleteFile` returns whether it deleted a row — `.returning({ id: storedFiles.id })`
and a boolean, or throw. ⭐ **Follow the house precedent you already found**, `updateTerms` in
`packages/db/src/repo/fixed-assets.ts:311-322`, whose own comment is the rule: *"changed nothing is
indistinguishable from success."* Match its shape unless returning a boolean genuinely suits the
sweep better — the sweep has a legitimate non-exceptional "this row was claimed, skip it" case,
which `updateTerms` does not, so a boolean may well be the better fit here. **Your call; say which
you chose and why.**

## Part 2 — ⛔ DEF-298: reverse the order, because the current order loses data

Today: `listOrphans` → **`driver.remove(bytes)`** → `deleteFile(row)`. If `linkFile` claims the
file between the read and the remove, the bytes go and `deleteFile`'s `isNull(linkedTo)` correctly
refuses the row — leaving a live row pointing at a `storage_path` that no longer exists.

**Contract — delete the row first, and remove the bytes only if the row was actually deleted:**

```
for each candidate:
    deleted = deleteFile(row)          # WHERE ... AND linked_to IS NULL, now reporting
    if not deleted:  skip, do NOT count as removed, do NOT touch storage
    driver.remove(bytes)               # only now
```

### ⭐ Why this order, and what it deliberately accepts

The database row is the authority on whether anything still references the file, and it is the only
participant that can decide atomically. Checking it first means a file claimed in the window keeps
**both** its row and its bytes — it simply is not an orphan any more, which is the truth.

⚠️ **The residual, named rather than hidden:** if `deleteFile` commits and `driver.remove` then
fails, the row is gone and the bytes are stranded in the object store. **That is accepted.** It is
the standard trade for object-store garbage collection and the asymmetry is the whole point:

- a surviving row with deleted bytes = **data loss**, silent, unrecoverable, and it is a journal
  entry's evidence;
- a deleted row with surviving bytes = **wasted storage**, detectable, and recoverable by a later
  sweep against the bucket.

⛔ **Do not attempt to fix the residual by holding the transaction open across `driver.remove`.**
That trades a benign failure for a worse one — a commit that fails after a successful remove
recreates the exact bug this task exists to remove, and it holds a database transaction across a
network call on a path that may process many rows.

⚠️ **If you disagree, say so as `[A] QUESTION` before building.** This is the one judgement call in
the task.

## Part 3 — site 3 of Ian's ruling

`scripts/bootstrap-org.ts:158` — `anyOrganizationExists` on a bare `transaction()`, while the same
file's `bootstrapOrganization` write at line 212 already uses `systemTransaction()`. Route the read
through the same door. The file is **already** a named caller, so no list changes.

⚠️ `scripts/` is now scanned by the caller guard (DEF-295, fixed today). It was not yesterday.

---

## Invariants

1. ⛔ **`removed` must count only files actually deleted.** The whole point of DEF-297 is that this
   number was fiction. A test must prove it: claim a file between the list and the delete and
   assert the count does not include it.
2. ⛔ **Never add or weaken an RLS policy.**
3. ⚠️ **The sweep must still not stop on one failure** — the existing `failed[]` behaviour is
   correct and deliberate (*"one unreachable object must not stop the sweep"*). Keep it, and make
   sure a skipped-because-claimed file is **not** reported as a failure either: it is neither
   removed nor failed. Decide what the return shape says about it and state your choice.
4. ⛔ **`sweepOrphanedFiles` keeps using `systemTransaction()`** (T-267) — it is a cross-org cron.
   Lines 83 and 180 of that file stay on bare `transaction()`.
5. ⚠️ The FK `expenses.receipt_file_id ON DELETE restrict` protects the ROW and does nothing for the
   BYTES. Do not cite it as covering this.

## Tests

Your DB: `shareat_test_lanea`. Restricted role ON, and also confirm green without it.

| Must prove | Why |
|---|---|
| a claimed-in-the-window file keeps **both** row and bytes | DEF-298, the data-loss case |
| `removed` does not count a file whose DELETE matched nothing | DEF-297, the fiction |
| an unclaimed orphan is still swept, row and bytes | the sweep must still work |
| a storage failure still lands in `failed[]` and does not stop the sweep | invariant 3 |

⭐ **Write the DEF-298 test so it fails against the CURRENT order first.** Simulate the claim
between the read and the remove (the storage driver is already fake-able — `files.test.ts` does
it). A test that only ever passed proves nothing.

## Out of scope

- ⛔ `tests/unit/*` guards, `packages/db/src/client.ts`, `packages/db/src/index.ts` — orchestrator's.
- ⛔ `packages/etl/**` — lane B. ⛔ Any migration; **no slot allocated**.
- ⛔ `PROJECT_BIBLE.md`, `docs/DEFECTS-REGISTER.md`, `docs/ROADMAP.html`, `docs/HANDOFF-TODAY.md`.
- ⛔ Any `git` write command · `npm run build` · `npm run dev` · `npm run test:integration`.
- ⛔ `listOrphans` itself, unless you find it is also wrong — in which case report, don't widen.

## Done when

- [ ] `deleteFile` reports whether it deleted; the sweep acts on that report.
- [ ] Row deleted before bytes removed; a claimed file keeps both and is not counted.
- [ ] `scripts/bootstrap-org.ts:158` uses `systemTransaction()`.
- [ ] The DEF-298 test demonstrably failed against the old order before it passed against the new.
- [ ] typecheck clean · unit green · your integration files green **both** with and without the flag.
- [ ] READY carries the real output of every gate, and your two judgement calls (Part 1's return
      shape, invariant 3's treatment of a skipped file) stated explicitly.
