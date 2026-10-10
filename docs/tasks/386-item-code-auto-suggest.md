# T-386: item codes are suggested from the name, fixed length, and never issued twice

**Status:** S5 APPLIED ON PRODUCTION 2026-10-10 with Ian (1 item: `coke15` -> `CK15-001`; recoded 1 · kept 0 · skipped 0). Next: post-check = 0, then S6 (the shape CHECK, migration 0192+). | Earlier: S1-S4 DONE 2026-10-09 — live via PR #4 (`7489bba`, migration 0189; prechecks run with Ian: 1 item, no case-twins). **S5 DONE 2026-10-09 locally (`2a62961`): `npm run recode-items` (dry run by default, `--apply`); goes up with the wrap-up PR (bible row 296), then dry run on production with Ian before `--apply`. S6 (shape CHECK) not started, gated on the production post-check = 0.** SPEC 2026-10-09 (Opus planner), written at main 462ed8c.
**Model:** Sonnet for each slice, tester first, then builder. Any amendment is written in plan mode (Opus).
**Migration:** **0189** (allocated to this task), hand-authored per ADR-012 §5; it adds triggers, so it is gated on the
FULL suite in CI on a PR (bible row 291; memory: a CHECK/trigger migration is gated on the full suite on a fresh gate
DB). Prechecks P0189a-e run READ ONLY with Ian before the push. **S6** (a database CHECK on the shape) needs a later
migration, numbered when it is picked up, and is gated on the production recode (§S6).
**Ruling behind it:** Ian, 2026-10-09, verbatim: *"item code must be auto suggest based on the typed name fixed length
with our own way how to formulate the code this way we can control duplication of code to avoid it"*. Open Questions
answered the same day: `item-code-q1-format` = **b** (`CHWN-001`, 4 characters from the name + 3 digits, 8 characters,
no kind prefix); `item-code-q2-override` = **a** (only a super-admin may change the suggested code, and only to another
code of the same shape); `item-code-q3-existing` = **a** (re-code every existing item once, logged with the old code);
`item-code-q4-rename` = **a** (the code stays on rename; the rename screen offers the new suggested code as a tick).
**Research:** the planner's research-evaluate-propose pass (2026-10-09, scratchpad `item-code-proposal.md`; its findings
are restated where used below, so this spec stands alone).
**Defect (PROPOSED; the orchestrator allocates; the register's head is DEF-617, T-385 proposed 618):** ⚠️ latent
23505 — `requestItem` stores a hand-typed `code` with no uniqueness check (`packages/domain/src/items/index.ts:594-604`)
and `approveItemRequest` copies it verbatim (`:646`), so two pending requests typed with the same code cannot both be
approved; the second dies on `items_org_code_key` with the generic sentence. Fixed by S3 (the code is allocated at
approval, never typed at request time).

## Goal
- Typing a new item's name fills in its code, in one shape for the whole business: `CHWN-001` — 4 characters taken from
  the name by a fixed rule, a dash, a 3-digit number. 8 characters, upper case, `A-Z 0-9 -` only.
- No two items ever share a code, ignoring case, in any status (active, retired, merged), and **a number once given
  out under a 4-character stem is never given out again** — not after a retire, a merge, a rename or a recode.
- Items whose names produce the same 4 characters are shown to the person typing ("CHWN-001 Chicken wings already
  exists — is this the same thing?"), which is the duplicate warning Ian asked for.
- Managers and admins see the suggestion locked. A super-admin may type a different code of the same shape.
- Every existing item is re-coded once to the new shape, each change logged with the old code.

## v1 as requirement (bible §1.2d: study, goal, count, beat)
1. **What v1 does.** v1 (`ERP-rebuild`) has **no item code**. Items are Firestore docs per store; the only human key
   is an optional `barcode` ("Scan or type the barcode/SKU"), unique per store by an app-level query
   (`src/lib/actions/item.actions.ts:46-61`, `src/app/inventory/items/page.tsx:137-143`). POS matches barcode, then
   name (`pos-item-map.actions.ts`).
2. **The goal underneath.** One recognisable handle per item, so staff find the right thing and do not create it twice.
3. **Count.** 842 v1 item records for ~385 real names across 6 stores; **187 names duplicated across stores**, including
   near-twins such as `3D W/LID` vs `3D W/LID.`. v2 grows by request + super-admin approval: hundreds of items, a few
   new ones a week. Contention on an allocator is effectively nil; 999 numbers per stem is never reached at this scale.
4. **Beat it.** One org-wide code per item, derived from the name so near-duplicates collide visibly at typing time; the
   number is issued by the database's own high-water mark under a row lock, so no screen, script or raw SQL can reuse
   one; uniqueness is case-insensitive in the database.

## Census, verified at source (`462ed8c`)
- `items.code text NOT NULL` (`packages/db/schema/items.ts:95`, comment "Short human key — `PORK-BELLY`"). Guards:
  `items_org_code_key UNIQUE (org_id, code)` — **case-sensitive** (0047:94; schema `:148`);
  `items_code_not_blank_check` (0047:40). `items_org_name_key` is `UNIQUE (org_id, lower(name))` (`:151`).
- **Code is display-only.** No repo, domain or ETL function looks an item up by code (T-383 census); POS maps by
  `pos_item_maps.item_id` (uuid). Changing a code reinterprets nothing.
- Writers of `items.code`: `createItem` (`domain/src/items/index.ts:52-77`, `approve_item`), `approveItemRequest`
  (`:624-666`, `approve_item`, copies `req.code`), `renameItem` (`:152-178`, T-383, `approve_item`, audited
  `rename_item`), `itemsRepo.insertItem` / `updateItem` (`packages/db/src/repo/items.ts:50,89`),
  `scripts/import-items.ts` (`codeFor` `:111-123`, raw insert `:247`), migration 0047's price-list backfill (history).
- `requestItem` (`:586-618`, `manage_items`) takes a typed `code` and stores it on `item_requests.code` (NOT NULL, no
  CHECK on code: 0050:81-90).
- Screens: `apps/erp/src/app/items/page.tsx` — the pending-requests list with the Approve form (`:142-166`); ONE form
  for "Request a new item" (`:227`, `FormGrid`/`Field`) with the `code` input (`:232-234`) and two submit buttons,
  "Request item" (`requestItemAction`) and "Add directly (super-admin)" (`formAction={createItemAction}`, `:295-300`).
  The page has no super-admin probe today. `apps/erp/src/app/items/[id]/page.tsx` — "Name and code" section
  (`:110-128`) inside `EditableRecord`, drawn when `mayApproveItem` (`:69-77`).
- Actions: `apps/erp/src/app/items/actions.ts` — `errorMessage` maps `items_org_code_key` by regex (`:65-67`);
  `requestItemAction` (`:72`), `createItemAction` (`:103`), `renameItemAction` (`:226`), `approveItemRequestAction`
  (`:245`).
- Allocation precedent: `allocateStaffCode` (`packages/db/src/repo/employment.ts:190`, parent row lock + `max()+1`).
  Advisory keys registry: `packages/db/src/repo/advisory-locks.ts` header. **This task uses neither** (see R4).
- Client components calling a server action for a preview: `apps/erp/src/app/ap/suppliers/[id]/AutoAllocatePaymentForm.tsx`
  and `channel-settlements/SettlementForm.tsx` (action passed as a prop). Client-safe domain subpaths:
  `packages/domain/package.json` `exports` (`./money-input`, `./money-lines`, ...).
- `CONSTRAINT_MESSAGES` has **42** keys, pinned at `apps/erp/tests/constraint-messages.test.ts:179` and
  `apps/erp/tests/integration/constraint-message-lookup-mechanism.test.ts`; `constraint-message-lookup.test.ts`
  requires every key provoked for real.
- Test call sites (grep at `462ed8c`): `createItem(` **59** calls in 31 test files; `requestItem(` **9** (items.test.ts 5,
  t378-s3 4); `renameItem(` 1 helper in `t383-item-rename-retire.test.ts`; raw `insert into items` / `insertItem(` the
  rest of **183** item-creating lines in **85** files. **No test code today is of the new shape**
  (grep `['"\`][A-Z0-9]{4}-[0-9]{3}['"\`]`: 0 hits), so the 0189 triggers touch no existing fixture.
- `audit_log.source` CHECK admits `web pos customer website apk kiosk cron ingestor etl` (`schema/audit-log.ts:60`).

## Rulings (planner)

### R1. The shape
`ITEM_CODE_RE = /^[A-Z0-9]{4}-(?!000)[0-9]{3}$/` — a 4-character **stem**, a dash, a number `001`-`999`. Always upper
case. A stem may contain digits (`CK15`, `3DLD`).

### R2. The stem rule — `itemCodeStem(name): string | null` (pure, deterministic, one implementation)
1. **Fold:** `name.normalize('NFKD')`, delete combining marks (`/\p{M}/gu`), upper-case. (`Jalapeño` -> `JALAPENO`.)
2. **Apostrophes vanish** (`'` and `’` are deleted, not separators): `Hershey's` -> `HERSHEYS`.
3. **Decimal joins:** a `.` or `,` between two digits is deleted: `1.5` -> `15`, `1,000` -> `1000`.
4. **Tokens:** the maximal runs of `[A-Z0-9]`; every other character separates (space, `/`, `-`, `.`, `&`, brackets).
   No tokens -> return `null` (the caller refuses; R5).
5. **Stop-words** dropped: `A AN AND FOR IN OF THE W WITH` (whole tokens only; `A4` is not `A`). If that leaves no
   token, keep the original tokens.
6. **Quotas** by the number of tokens `k` left: `k=1` -> `[4]`; `k=2` -> `[2,2]`; `k=3` -> `[2,1,1]`; `k>=4` -> `[1,1,1,1]`
   over the first four tokens.
7. **Carry:** walk the tokens in order; each takes `want = quota + carry` characters via `abbr(token, want)`; `carry =
   want - part.length` (a short token passes its unused room to the next). Concatenate; pad the end with `X` to 4.
8. **`abbr(word, n)`:** if `word.length <= n`, the whole word. Otherwise choose positions: position 0; then, left to
   right, each **consonant** position (anything not `A E I O U`; `Y` and digits count as consonants), **skipping a
   letter identical to the character just before it** (doubled letters count once; digits are never skipped), until
   `n` are chosen; if still short, add the earliest positions not yet chosen. Output the chosen characters in the
   word's own order.

**Worked examples (the S1 table test carries every row; codes assume an empty counter, in the order listed):**

| Name | Tokens after 1-5 | Parts | Stem | Code |
|---|---|---|---|---|
| Chicken wings | CHICKEN, WINGS | CH + WN | CHWN | `CHWN-001` |
| Chicken winglets | CHICKEN, WINGLETS | CH + WN | CHWN | `CHWN-002` — **collision**: the form lists CHWN-001 Chicken wings |
| Pork belly | PORK, BELLY | PR + BL (`LL` once) | PRBL | `PRBL-001` |
| Pork belly sliced | PORK, BELLY, SLICED | PR + B + S | PRBS | `PRBS-001` |
| Soy sauce | SOY, SAUCE | SY + SC | SYSC | `SYSC-001` |
| Coke 1.5 | COKE, 15 | CK + 15 | CK15 | `CK15-001` |
| Coke 1.5L | COKE, 15L | CK + 15 | CK15 | `CK15-002` — **collision**: likely the same product, flagged |
| Coke 15 | COKE, 15 | CK + 15 | CK15 | `CK15-003` — **collision**: may be a different product; flagged, never blocked |
| Coke 330ml | COKE, 330ML | CK + 33 (digits never skipped) | CK33 | `CK33-001` |
| Charcoal | CHARCOAL | CHRC | CHRC | `CHRC-001` |
| Samgyup bento box | SAMGYUP, BENTO, BOX | SM + B + B | SMBB | `SMBB-001` |
| 3D W/LID | 3D, LID (`W` dropped) | 3D + LD | 3DLD | `3DLD-001` |
| 3D W/LID. | 3D, LID | 3D + LD | 3DLD | `3DLD-002` — **collision**: v1's real duplicate pair, now caught at typing |
| Beef Premium 5kg pack | BEEF, PREMIUM, 5KG, PACK | B + P + 5 + P | BP5P | `BP5P-001` |
| Jalapeño | JALAPENO | JLPN | JLPN | `JLPN-001` |
| Tissue | TISSUE | T, S (`SS` once), then earliest unused: I, S | TISS | `TISS-001` |
| Ice | ICE | ICE (whole word) + pad | ICEX | `ICEX-001` |
| U bolt | U, BOLT | U (carry 1) + BLT | UBLT | `UBLT-001` |
| Salt & pepper | SALT, PEPPER | SL + PP | SLPP | `SLPP-001` |
| Hershey's | HERSHEYS | HRSH | HRSH | `HRSH-001` |
| Coke 1.5 (old) | COKE, 15, OLD | CK + 1 + O | CK1O | rename suggestion only; the code **stays** `CK15-001` unless ticked (R8) |
| `--` | (none) | — | `null` | refused (R5) |

### R3. Case-insensitive uniqueness (migration 0189)
`items_org_code_key` becomes `UNIQUE (org_id, upper(code))`, **same name**, so `errorMessage`'s regex
(`actions.ts:65`) and T-383's R4 test keep working. The domain upper-cases every code it writes.

### R4. Allocation: a per-stem high-water mark the database keeps (migration 0189)
- New table **`item_code_counters`** `(org_id uuid NOT NULL -> organizations, stem text NOT NULL, last_seq integer NOT
  NULL, updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (org_id, stem))`, CHECKs `stem ~ '^[A-Z0-9]{4}$'`
  and `last_seq BETWEEN 0 AND 999`. One row per stem ever used; `last_seq` is the highest number ever issued under it.
- **Why a table, not `max(seq)` over `items` (the research proposal's first idea):** codes change (a rename that adopts a
  new code, the recode, a super-admin override). `max()` over current codes would fall back and re-issue a number that
  was printed on an old count sheet or PO. Only a record of what was issued can keep "never reused" true.
- **Trigger `items_code_never_reused`** (BEFORE INSERT OR UPDATE OF code ON items, FOR EACH ROW, `WHEN (NEW.code ~
  '^[A-Z0-9]{4}-[0-9]{3}$')`; the function returns at once on an UPDATE whose code did not change): ensure the counter
  row exists (`INSERT ... ON CONFLICT DO NOTHING` with `last_seq = 0`), `SELECT last_seq ... FOR UPDATE`, **raise
  unless the new number is greater than `last_seq`**, then set `last_seq` to it. So the database alone guarantees: no
  number at or below a stem's high-water mark is ever written again, by any path and any role, and the mark only rises.
  Codes not of the shape (legacy, every existing test fixture) pass untouched until S6.
- **Trigger `item_code_counters_forward_only`** (BEFORE UPDATE ON item_code_counters): raise if `NEW.last_seq <
  OLD.last_seq` or the key changes. No DELETE grant. So the mark cannot be lowered by hand under the app role.
- **The domain allocator** (`allocateItemCode(trx, orgId, stem)`, internal, `packages/domain/src/items/code-allocation.ts`):
  ensure the row, `SELECT last_seq ... FOR UPDATE` (repo `lockItemCodeStem`), `next = last_seq + 1`; `next > 999` ->
  refuse (R5); return `formatItemCode(stem, next)`. The insert/update that follows fires the trigger in the same
  transaction, which re-locks the same row (already held) and raises the mark. **The row lock is the lock**: two
  simultaneous approvals for the same stem serialise on it for milliseconds; different stems never wait. No advisory
  namespace is added.
- **Seed:** 0189 seeds `item_code_counters` from every existing code already of the shape (P0189b; expected 0), so the
  invariant "every shaped code's number <= its stem's mark" holds from the first statement.

### R5. Where a code is assigned, and the sentences
- **At creation only.** `createItem` and `approveItemRequest` allocate inside their own transaction. **Never at request
  time**: a request stores only a preview (R6).
- `CreateItemInput.code` becomes **optional**: absent or blank -> allocate from `itemCodeStem(name)`. Present -> an
  override (R7).
- `approveItemRequest` gains optional `code` (override, R7); absent -> allocate from the request's name.
- Refusals (via `refuse(log, sentence)`, `domain/src/shared/refusal`; no ids or item names in a sentence):
  - stem `null`: **"Give the item a name with letters or numbers in it."**
  - stem full: **"Every number under {STEM} has been used (999 items). A super-admin can type a code with different
    letters."**
  - override shape: **"An item code is 4 letters or numbers, a dash and 3 digits, like CHWN-001."**
  - override number not above the mark: **"{CODE} cannot be used: numbers up to {STEM}-{LAST} have already been given
    out under {STEM}. The next free one is {STEM}-{NEXT}."** (This also covers "already in use": every live code's
    number is at or below its mark.)
- `CONSTRAINT_MESSAGES` gains **`items_code_never_reused`: "That code's number has already been given out under those
  letters. Leave the code blank to get the next free one."** (42 -> 43). `item_code_counters_forward_only` gets no
  sentence (no screen can reach it).

### R6. Requests keep a frozen preview; managers cannot choose a code
- `RequestItemInput` **loses `code`**. `requestItem` computes `suggestItemCode` (R9) without allocating and stores the
  preview in `item_requests.code` (NOT NULL): the next code at that moment, or `{STEM}-???` when the stem is full. A
  name with no stem is refused with R5's sentence before anything is stored.
- The frozen `similarWarning` gains the same-stem items: *"Same code letters as: CHWN-001 Chicken wings (active)"*,
  joined with the existing trigram text by `; `; an item in both lists appears once.
- The pending list shows, per request, **"Will be coded {CODE} on approval"** computed at render (R9), and the
  same-stem items. The stored preview is not shown as the code.

### R7. The super-admin override (q2 = a)
- Only paths gated by `approve_item` accept a code: `createItem`, `approveItemRequest`, `renameItem`. `requestItem`
  accepts none (R6). So managers and admins can never set one, by construction, not by screen.
- Override = `trim`, upper-case, then `ITEM_CODE_RE` (R5 shape sentence), then `number > that stem's last_seq` (R5
  sentence; read with the same `FOR UPDATE` lock). The stem of an override need **not** be the name's stem (Ian: "another
  code of the same shape"). The trigger and the unique index back both checks.

### R8. Rename (q4 = a) — `renameItem(tx, actor, { itemId, name, code, adoptSuggestedCode? })`
- Order unchanged from T-383: authorize `approve_item` -> read (gone) -> compute -> no-op check -> update -> audit.
- `adoptSuggestedCode === true`: the typed `code` is ignored. If the current code is of the shape **and** its stem equals
  `itemCodeStem(newName)`, the code stays; else a new code is allocated for the new name. Default false.
- Otherwise: if the trimmed typed code equals `item.code` exactly -> unchanged (so a legacy code survives a rename before
  the recode). A **blank** code passes to the database as blank (T-383 R5 unchanged: the CHECK speaks). Any other
  changed code is an override (R7).
- The audit row is T-383's (`rename_item`, before/after `{ name, code }`). Status never written (T-383 R8).

### R9. The live suggestion — `suggestItemCode(tx, actor, { name, forItemId? })`
- `authorize(..., 'manage_items')` (requesters use it). Read-only: **never** creates a counter row, never locks.
- Returns `{ stem: string | null, code: string | null, full: boolean, sameStem: { id, code, name, status }[] }`:
  `code = stem-(last_seq+1)` (0 when no row); with `forItemId`, the item's own code when it is shaped with that stem;
  `sameStem` = items of any status whose `upper(code)` starts `{STEM}-`, ordered by code, at most 10, excluding
  `forItemId`.
- Repo reads in new `packages/db/src/repo/item-codes.ts`: `peekItemCodeStem`, `lockItemCodeStem`, `itemsSharingStem`
  (each filtered by `org_id`; RLS backs it).

### R10. The forms (bible rows 288, 289; full width; `FormGrid`/`Field`; `EditableRecord` on the item page)
- New client component **`apps/erp/src/app/items/ItemCodeField.tsx`** (`'use client'`), props `{ nameInputId, mode:
  'new' | 'rename', canOverride: boolean, currentCode?, itemId?, suggestAction }`. It reads the Name input's value,
  shows the stem at once from `itemCodeStem` (imported from the new client-safe subpath
  **`@shareat/domain/item-code`**), and calls `suggestAction` (a server action prop, the AutoAllocatePaymentForm
  pattern) debounced 300 ms for the number and the same-stem list.
  - Read-only display (monospace) **"CHWN-002"** and the line *"Filled in from the name. The number is fixed when the
    item is saved."* While the server answer is pending: `CHWN-…`. With JavaScript off: *"Filled in when saved."*
  - Same-stem readout (amber, only when non-empty): *"Already coded CHWN: CHWN-001 Chicken wings, CHWN-002 Chicken
    winglets (retired). Is this the same thing?"*
  - `mode='new'` and `canOverride`: an optional input `name="code"` labelled *"Use a different code (super-admin)"*,
    placeholder = the suggestion, `pattern="[A-Za-z0-9]{4}-[0-9]{3}"`. Not drawn for others.
  - `mode='rename'`: the existing `code` input stays (the section is super-admin-only already) and a checkbox
    `adoptSuggestedCode` labelled *"Use the suggested code for the new name: {CODE}"*, unticked by default; ticking it
    greys the code input (cosmetic; the server ignores the typed code when ticked).
- `/items` page: a `mayApproveItem` probe (copy `[id]/page.tsx:69-77`) feeds `canOverride`. The Request form's old
  `code` input (`:232-234`) is replaced by `ItemCodeField mode='new'`. `requestItemAction` stops reading `code`;
  `createItemAction` passes `code: str(fd,'code') || undefined`.
- Approve form (`:142`): for `mayApproveItem`, an optional `code` input, placeholder = the render-time "Will be coded"
  value; `approveItemRequestAction` passes it (blank -> undefined). Flash on approve: **"Approved as {CODE}."**
- `[id]/page.tsx` "Name and code": `ItemCodeField mode='rename'` beside the existing fields inside `EditableRecord`
  (locked until Edit; Save/Cancel unchanged). `renameItemAction` passes `adoptSuggestedCode: flag(fd,
  'adoptSuggestedCode')`.
- New server action `suggestItemCodeAction(name: string, forItemId?: string)` in `actions.ts` -> `suggestItemCode`
  under `withOrgPrincipal`; returns the R9 object, or `{ stem: null, code: null, full: false, sameStem: [] }` on
  `AuthorizationError`.

### R11. The one-time recode (q3 = a)
- Domain `recodeItems(tx, actor, { orgId })` in new `packages/domain/src/items/recode.ts`: `authorize(...,
  'approve_item')`; every item of the org whose code is **not** of the shape, **every status**, ordered by
  `created_at, id` (the oldest item gets `-001`); for each: stem null -> listed `skipped: name has no letters or
  numbers`, left as is; else `allocateItemCode` -> `itemsRepo.updateItem(code)` -> `auditLogRepo.append({ action:
  'recode_item', entity: 'items', entityId, before: { code }, after: { code }, source: 'etl' })` (`etl`: a one-time data
  conversion; no CHECK change). Returns `[{ itemId, name, status, from, to | null, note }]`. Items already of the shape
  are untouched (and their numbers are already in the mark, R4 seed). **Idempotent:** a second run finds 0.
- **`scripts/recode-items.ts`**: `--org=<uuid> --actor=<person uuid of a super-admin>`, **dry run by default**: runs
  `recodeItems` in one transaction under `withOrgPrincipal` and ROLLS BACK, printing `old -> new  name (status)` for
  every row, the skipped list, and counts (`recoded N · kept M · skipped K`), so the dry run shows the exact codes the
  apply will write. `--apply` commits the same transaction. Exit 1 when K > 0 or the org has no items.
- `scripts/import-items.ts`: `codeFor` is deleted; each insert allocates through `allocateItemCode` in the same
  transaction (builder: run the insert through `itemsRepo.insertItem` under `withOrgPrincipal` if the raw `sql` client
  cannot share the transaction). Re-runs stay safe (`ON CONFLICT` on the name index; a skipped insert must not consume a
  number — allocate only after the name is known to be new).
- Run order (§Rollout): after 0189 is deployed, dry run on dev, then on production with Ian, then `--apply`.

### R12. A database CHECK on the shape: later (S6), not in 0189
Weighed: (1) production rows are **not** of the shape until R11 runs, which is after 0189 is applied, so a plain CHECK
cannot be created in 0189, and `NOT VALID` would refuse every later UPDATE of a legacy row (a flag edit, a retire) in
the window before the recode; (2) ~120 test sites (`insert into items` raw SQL and `insertItem`) write free codes and
would all go red at once; (3) meanwhile the database already enforces what matters for duplication — case-insensitive
uniqueness (R3) and never-reuse for every shaped code (R4) — and the domain is the one write path for new codes. So
0189 does not carry it. **S6** adds `items_code_shape_check CHECK (code ~ '^[A-Z0-9]{4}-[0-9]{3}$' AND right(code, 3)
<> '000')` once production's recode post-check reads 0, with a fixture helper sweep. Bible RULES §6.3 is satisfied for the rule Ian asked for (no duplicate codes) from 0189;
the shape follows.

## Invariants
- I1 `UNIQUE (org_id, upper(code))` on items, every status.
- I2 For every item code of the shape: its number <= `item_code_counters.last_seq` for its (org, stem), and no write may
  set a shaped code whose number is <= that mark (trigger). The mark never falls (trigger + no DELETE grant).
- I3 Only `approve_item` paths accept a code; `requestItem` takes none.
- I4 Every code change on an existing item writes one `audit_log` row with the old code (`rename_item` or
  `recode_item`).
- I5 `itemCodeStem` exists once (`packages/domain/src/items/code.ts`); the form and the server import the same function.
- I6 `suggestItemCode` writes nothing.
- I7 No money, stock or ledger row is touched; POS mapping is by uuid and unaffected.

## Parallel plan
All slices are sequential (one test DB, shared files). S1 -> S2 -> S3 -> S4 -> S5; S6 later, gated.

---

## S1: the stem (pure)
**Files.** TESTER: `packages/domain/tests/t386-s1-item-code-stem.test.ts` (new, unit). BUILDER:
`packages/domain/src/items/code.ts` (new: `itemCodeStem`, `abbr` (exported for the test), `ITEM_CODE_RE`,
`formatItemCode(stem, seq)`, `parseItemCode(code) -> { stem, seq } | null`, `STOP_WORDS`); `packages/domain/package.json`
`exports` `"./item-code": "./src/items/code.ts"`; `packages/domain/src/items/index.ts` re-export.
**`code.ts` imports nothing** from `@shareat/db` or any server module (it ships to the browser). A unit test leg asserts
the file's import list is empty.
**Tests (red today: the module does not exist).**
- T1 table: every row of R2's table (name -> stem), plus more real names: `Kimchi` KMCH, `Gochujang` GCHJ, `Calamansi`
  CLMN, `Coffee` COFF, `Gloves` GLVS, `Milkis` MLKS, `Egg` EGGX, `A4 bond paper` A4BP, `The` THEX, `Pre-cut` PRCT,
  `Mozzarella` MZRL, `Pepper` PEPR, `Beef 2.5kg pack` BF2P. Mutants, each red on the named row: drop the doubled-letter skip -> `Mozzarella`
  (MZZR) and `Pepper` (PPPR) red; treat `Y` as a vowel -> `Soy sauce` red (SOSC); skip doubled digits -> `Coke 330ml`
  red (CK30); no carry -> `U bolt` red (UBLX); no decimal join -> `Beef 2.5kg pack` red (B25P; note `Coke 1.5` alone does NOT catch it: CK+1+5 is still CK15); no NFKD fold
  -> `Jalapeño` red; apostrophe as a separator -> `Hershey's` red (HRSX); `W` not a stop-word -> `3D W/LID` red (3DWL).
- T2 `itemCodeStem('--')`, `('   ')`, `('&/.')` -> `null`.
- T3 determinism: the same name twice, and the name in other cases/extra spaces (`  chicken   WINGS `) -> same stem.
- T4 `ITEM_CODE_RE`: accepts `CHWN-001`, `3DLD-999`; refuses `chwn-001`, `CHWN-000`, `CHWN-01`, `CHW-001`, `CHWN001`,
  `CHWN-0001`, `CH N-001`.
- T5 `formatItemCode('CHWN', 7)` = `CHWN-007`; `parseItemCode('CHWN-007')` = `{ stem: 'CHWN', seq: 7 }`; `parseItemCode('PORK-BELLY')` = null.
- T6 the import-list leg (no `@shareat/db`, no `../` import beyond `./`).

## S2: migration 0189 (database)
**R2a 0189 contents** (header follows 0188's model: purpose, what it guards, prechecks, "hand-authored per ADR-012 §5"):
1. `DROP INDEX "items_org_code_key";` then `CREATE UNIQUE INDEX "items_org_code_key" ON "items" USING btree ("org_id",
   upper("code"));`
2. `CREATE TABLE "item_code_counters"` per R4, FK `org_id -> organizations(id) ON DELETE RESTRICT`.
3. RLS: `ENABLE` + `FORCE ROW LEVEL SECURITY`; policy `item_code_counters_org_isolation` `USING ("org_id" =
   app_current_org()) WITH CHECK ("org_id" = app_current_org())` (0183:219-224 idiom).
4. `GRANT SELECT, INSERT, UPDATE ON "item_code_counters" TO "shareat_app";` (UPDATE: the trigger raises the mark and
   `FOR UPDATE` needs it; ADR-012 §5 4a). No DELETE.
5. Seed, `SET LOCAL row_security = off;` ... `SET LOCAL row_security = on;` (the 0187/0188 block; must run as
   `doadmin`): `INSERT INTO item_code_counters (org_id, stem, last_seq) SELECT org_id, left(code,4),
   max(right(code,3)::int) FROM items WHERE code ~ '^[A-Z0-9]{4}-[0-9]{3}$' GROUP BY 1, 2;`
6. Function `items_check_code_never_reused()` + trigger `items_code_never_reused` (R4). Raise `ERRCODE = '23514',
   CONSTRAINT = 'items_code_never_reused'`, message `'Item code % was already issued (high-water mark % for %) (T-386).'`.
   SECURITY INVOKER (default).
7. Function `item_code_counters_check_forward_only()` + trigger `item_code_counters_forward_only` BEFORE UPDATE, raise
   23514 / `CONSTRAINT = 'item_code_counters_forward_only'`; then `ALTER TABLE "item_code_counters" ENABLE ALWAYS
   TRIGGER "item_code_counters_forward_only";` (0168 idiom).
8. Journal: idx 189, `when = 1802316707084 + 86_400_000 = 1802403107084`, tag `0189_t386_item_codes`.

**Registrations.**
- `packages/db/src/triggers/registry.ts`: `items_code_never_reused: { table: 'items', mode: 'origin', kind:
  'validator', reason: 'A shaped item code must be above its stem\'s high-water mark (T-386, 0189) - reads another
  row\'s CURRENT state (item_code_counters); a restore loads the counters with the items, so it stays silent on
  replay.' }`; `item_code_counters_forward_only: { table: 'item_code_counters', mode: 'always', kind:
  'history_guard', reason: 'The mark records numbers already issued; lowering it would re-issue them. Decides from
  OLD/NEW only (T-386, 0189).' }`.
- `packages/db/src/rls/registry.ts`: `item_code_counters: { scope: 'org_column', reason: 'The highest item-code number
  issued per 4-character stem, per org. Org-scoped like the item master it numbers.' }`.
- `packages/db/src/cutover/classification.ts`: `item_code_counters: { class: 'keep', reason: 'Items are kept, so the
  numbers already issued to them must stay issued; purging the marks would let a kept item\'s number be issued
  again.' }`.
- `packages/db/schema/items.ts`: `itemCodeCounters` table (PK, the two CHECKs, FK); on `items` the index becomes
  `uniqueIndex('items_org_code_key').on(t.orgId, sql\`upper(${t.code})\`)`; NOTE comments: `// NOTE: items_code_never_reused
  trigger hand-added in migration 0189 (T-386)` beside `code`, and the forward-only trigger + RLS beside the new table.
  Comment on `code` updated: "Item code `CHWN-001` (T-386): 4 characters from the name + 3 digits."
- `apps/erp/src/lib/constraint-messages.ts`: the R5 key (42 -> 43).
- `docs/ops/README.md`: the 0189 deploy-gate row (§Prechecks).

**Files.** TESTER: `packages/db/tests/integration/t386-s2-item-codes-db.test.ts` (new); the two pinned key-count tests
(42 -> 43, dated comment); one leg in `apps/erp/tests/integration/constraint-message-lookup.test.ts`. BUILDER:
`packages/db/migrations/0189_t386_item_codes.sql`, `packages/db/migrations/meta/_journal.json`, the four registrations
above, `apps/erp/src/lib/constraint-messages.ts`, `docs/ops/README.md`.

**Tests (as `shareat_app` under the org principal unless named; red today: no table/trigger/new index).**
- D1 case twin: the org has legacy `ABCD-EFG`; insert another item with `abcd-efg` -> 23505 `items_org_code_key`.
  *Red today* (case-sensitive index). Mutant: index on `code` -> red.
- D2 insert `CHWN-001` -> counter row (org, CHWN, 1) exists. Insert `CHWN-001` again on another item -> refused (23514
  `items_code_never_reused` fires before the unique index). Insert `CHWN-003` -> ok, mark 3. Then `CHWN-002` -> refused
  (a gap below the mark is never filled). Mutant: `>=` instead of `>` -> D2 second leg red; drop the mark update ->
  third/fourth legs red.
- D3 retire then rename-away: item `CHWN-001` updated to `CHWT-001` -> ok; a new item `CHWN-001` -> refused (number
  freed by a code change is not reusable). Merged item likewise.
- D4 UPDATE of a non-code column on a shaped item (name, status) -> ok, mark unchanged (the UPDATE OF code / unchanged
  early return). Mutant: drop the unchanged check -> red (its own number is not above the mark).
- D5 legacy codes pass: insert `PORK-BELLY`, update to `PORK-BELLY-2` -> ok, no counter row. Mutant: trigger without the
  WHEN -> red.
- D6 `UPDATE item_code_counters SET last_seq = 0` -> refused `item_code_counters_forward_only`; `DELETE` -> 42501.
  As the owner/superuser, the same UPDATE -> still refused. Changing `stem` -> refused.
- D7 RLS: org B's principal sees no org A counter rows; inserting an org A row under org B -> refused by the policy.
- D8 seed: on a DB where an item `ABCD-007` existed before 0189 (simulate: insert with the trigger disabled in the test
  via `session_replication_role = replica` as owner, then run the seed statement copied from the migration) -> mark 7.
  (Builder may instead prove the seed with the scratch-DB apply in ADR-012 §5.8; name which in the commit.)
- D9 triggers present: `items_code_never_reused` `tgenabled = 'O'`, `item_code_counters_forward_only` `tgenabled = 'A'`
  (the T-354 guard covers both once registered; this names them).
- D10 the lookup leg: `errorMessage` of D2's refusal = R5's sentence.

## S3: domain — allocate, override, request preview, rename, suggest
**Files.** TESTER: `packages/domain/tests/integration/t386-s3-item-code-domain.test.ts` (new); fallout: the 59
`createItem(` sites in 31 files (list: grep `createItem(` under `packages/*/tests`, `apps/erp/tests`), the 9
`requestItem(` sites (`items.test.ts`, `t378-s3-item-unit-and-flags.test.ts`), `t383-item-rename-retire.test.ts`;
`tests/unit/domain-actions-have-callers.test.ts` only if S3 lands before S4/S5 wire the callers (prefer: no EXEMPT rows;
S4 and S5 give the callers — if the guard is red at the S3 commit, the S3 commit adds temporary EXEMPT rows kind 4
citing T-386 S4/S5 and S4/S5 delete them). BUILDER: `packages/domain/src/items/code-allocation.ts` (new,
`allocateItemCode`, `validateItemCodeOverride`), `packages/domain/src/items/index.ts` (`createItem`, `requestItem`,
`approveItemRequest`, `renameItem`, `suggestItemCode`, `warningFrom`), `packages/db/src/repo/item-codes.ts` (new),
`packages/db/src/index.ts` (`export * as itemCodesRepo`).

**Fallout rule for the tester:** a `createItem` call whose test does not assert on the code drops its `code:` property
(the code is allocated). A test that asserts on a specific code passes a shaped override (unique within the test's
org). `requestItem` calls drop `code:`. T-383: every code becomes shaped (`COKE15` -> `CK15-001`, `COKE15-OLD` ->
`CK1O-001`); **R4's code leg changes expectation** from `items_org_code_key` to R5's "cannot be used" sentence (the
domain's mark check now speaks first) — list it in the commit body. Every other leg only swaps data.

**Tests (red today unless marked control).**
- A1 `createItem` with no code, name "Chicken wings" -> code `CHWN-001`; a second, "Chicken winglets" -> `CHWN-002`.
  Mutant: allocator returns `last_seq` (not +1) -> red.
- A2 override: super-admin `createItem` "Coke 1.5" with `code: ' ck15-005 '` -> stored `CK15-005`; then a new "Coke
  1.5L" with no code -> `CK15-006`. Override `CK15-003` -> refused, R5 "cannot be used ... next free one is CK15-007"
  sentence. Override `COKE15` -> shape sentence. Mutants: no upper-case -> red; no mark check (trigger only) -> the
  sentence differs (23514 generic) -> red.
- A3 stem full: seed the mark to 999 for `CHWN` (via a real `CHWN-999` override), `createItem` "Chicken wings 2" (stem
  CHWN) -> the full sentence; with override `CHWX-001` -> ok.
- A4 null stem: name `--` -> "Give the item a name with letters or numbers in it."; nothing written, no counter row.
- A5 requests (the DEF): two managers request "Chicken wings" and "Chicken winglets" (both stem CHWN) before either is
  approved; both `item_requests.code` = `CHWN-001` (the same preview: a preview, not a promise); approve both ->
  `CHWN-001` and `CHWN-002`, no error. *Red today:* `requestItem` demands a typed code, and two equal typed codes make
  the second approval die on 23505. Mutant: approval copies `req.code` -> red.
- A6 `requestItem` ignores a code: TS-level the input has none; at runtime `requestItem(tx, manager, { ...,
  code: 'ZZZZ-001' } as never)` stores the preview, not `ZZZZ-001`. Mutant: `input.code ?? preview` -> red.
- A7 `approveItemRequest` with override `code: 'SYSC-010'` -> item `SYSC-010`.
- A8 manager calling `createItem`/`approveItemRequest` -> `AuthorizationError` (control, unchanged).
- A9 concurrency: two transactions on separate connections (`Promise.all`, `employment.test.ts:243` pattern) approve two
  CHWN requests at once -> `{CHWN-001, CHWN-002}` in some order, both succeed. Mutant: drop `FOR UPDATE` in
  `lockItemCodeStem` -> one fails (23514 or 23505) -> red. Run it 5 times in the leg.
- A10 never reused across retire and rename: create "Pork belly" (`PRBL-001`), retire it (`setItemStatus` if T-383 S2
  is built, else a raw status update), rename it "Pork belly (old)" with the adopt tick (-> `PRBO-001`; PORK, BELLY,
  OLD -> PR + B + O). Now no item holds `PRBL-001`; create "Pork belly" again -> `PRBL-002`, never `-001`. Mutant: the
  allocator uses `max()` over current codes -> `-001` -> red.
- A11 `warningFrom`: request "Chicken winglets" after `CHWN-001 Chicken wings` exists -> `similarWarning` contains
  "Same code letters as: CHWN-001 Chicken wings (active)" once, even when the trigram list also has it.
- R-legs (rename, R8): R1 adopt ticked, "Chicken wings" `CHWN-001` -> "Chicken wing tips" (CHICKEN, WING, TIPS ->
  CH + W + T = CHWT) -> code `CHWT-001`, audit before `CHWN-001` after `CHWT-001`. R2 adopt ticked, rename
  "Pork belly" -> "Pork Belly" (same stem PRBL, shaped) -> code stays `PRBL-001`; audit has the name change only. R3
  adopt unticked, code unchanged -> code stays (q4 default). R4 legacy code `PORK-BELLY` unchanged on rename -> ok (no
  shape check on an unchanged code). R5 adopt ticked on legacy `PORK-BELLY` -> allocated `PRBL-00n`. R6 typed override
  `PRBL-001` (already issued) -> R5 sentence. R7 blank code, unticked -> the DB CHECK's T-383 sentence (unchanged).
  Mutants: adopt ignored -> R1 red; adopt always re-allocates -> R2 red; shape-check unchanged codes -> R4 red.
- S-legs (`suggestItemCode`): with `CHWN-001` and `CHWN-002` (retired) existing -> `{ stem: 'CHWN', code: 'CHWN-003',
  sameStem: [both, with statuses] }`; no counter row is created for a fresh stem (`count(*)` of counters unchanged).
  `forItemId` of the `CHWN-001` item with name "Chicken wings" -> `code: 'CHWN-001'`, itself excluded from `sameStem`.
  Manager allowed (`manage_items`); a person without it -> `AuthorizationError`. Mutant: suggestion through
  `lockItemCodeStem` -> the no-write leg red.

## S4: the screens
**Files.** TESTER: `apps/erp/tests/integration/t386-s4-item-code-web.test.ts` (new; harness from
`t383-item-rename-retire-web.test.ts` / `t378-s4-unit-form-gate.test.ts`: `RedirectSignal`, `ACTOR_HOLDER`,
`renderToStaticMarkup`); `apps/erp/tests/action-link-sweep.test.ts` census and `touch-target-baseline.json` only as the
census run requires (dated comment naming the new controls: the override input, the approve code input, the adopt
checkbox); remove any S3 temporary EXEMPT row for `suggestItemCode`. BUILDER: `apps/erp/src/app/items/ItemCodeField.tsx`
(new), `apps/erp/src/app/items/page.tsx`, `apps/erp/src/app/items/[id]/page.tsx`, `apps/erp/src/app/items/actions.ts`,
`apps/erp/src/app/items/lib.ts` (render-time "Will be coded" per pending request via `suggestItemCode`).
**Tests.**
- W1 `/items` as manager: the Request form has the read-only code display and **no input named `code`**; as super-admin:
  an input `name="code"` with the R10 label. *Red today* (a required `code` input for all). Mutant: draw the override for
  everyone -> manager leg red.
- W2 `requestItemAction` with formData `code=ZZZZ-001` as manager -> the request's stored code is the preview; flash ok.
- W3 `createItemAction` as super-admin, blank `code` -> item coded `CHWN-001`; with `code=ck15-005` -> `CK15-005`; with
  `code=bad` -> red flash = the shape sentence.
- W4 pending list: a request for "Chicken winglets" with `CHWN-001` existing renders "Will be coded CHWN-002 on
  approval" and the same-stem line; the approve form has an optional `code` input for the super-admin only.
  `approveItemRequestAction` blank -> flash "Approved as CHWN-002."; with `code=CHWX-001` -> "Approved as CHWX-001."
- W5 `/items/{id}` as super-admin: the rename section inside `EditableRecord` has the `adoptSuggestedCode` checkbox,
  unticked; `renameItemAction` with it ticked and a new name -> the code changes and the flash is "Renamed."; unticked
  -> the code stays. Manager: no section form (T-383 W1, unchanged).
- W6 `suggestItemCodeAction('Chicken winglets')` as manager returns `code: 'CHWN-002'` and one `sameStem`; as a person
  without `manage_items` returns the empty object (no throw).
- W7 `ItemCodeField` renders (server-side, `renderToStaticMarkup`) the no-JS line *"Filled in when saved."* inside a
  `<noscript>` and the stem placeholder.

## S5: the recode script and the importer
**Files.** TESTER: `packages/domain/tests/integration/t386-s5-recode.test.ts` (new); `tests/unit/domain-actions-have-callers.test.ts`
(an EXEMPT row kind 3 for `recodeItems`: *"JOB — `scripts/recode-items.ts` (T-386 R11), a one-time run with Ian"*,
unless the guard already counts `scripts/` callers — the tester checks and says which). BUILDER:
`packages/domain/src/items/recode.ts` (new), `packages/domain/src/items/index.ts` (re-export), `scripts/recode-items.ts`
(new), `scripts/import-items.ts`, `package.json` script `"recode-items": "tsx scripts/recode-items.ts"` (match the
neighbours' runner).
**Tests.**
- C1 org with legacy items created in order: "Pork belly" `PORK-BELLY` (active), "Chicken wings" `CHICKEN-WINGS`
  (inactive), "Chicken winglets" `CHICKEN-WINGLETS` (merged into wings), "Coke 1.5" `COKE-1-5`, and one already-shaped
  `CK15-004` "Coke 15": `recodeItems` -> PRBL-001, CHWN-001, CHWN-002, CK15-005 (the mark was 4), the shaped one kept;
  one `recode_item` audit row each with before/after code; statuses unchanged. Mutants: skip non-active items -> red
  (q3 is every item); order by name instead of `created_at` -> red.
- C2 run again -> 0 recoded, no new audit rows (idempotent).
- C3 a manager -> `AuthorizationError`, nothing changed.
- C4 an item named `--` (raw insert) -> listed skipped, code unchanged; the rest recoded.
- C5 dry run: the script's dry-run mode (call its exported `run({ apply: false })`) prints the same `old -> new` lines the
  apply writes, and the DB is unchanged after it. Mutant: dry run commits -> red.
- C6 importer: `import-items.ts` against the test DB with two names sharing a stem -> `-001`, `-002`; a re-run inserts
  nothing and consumes no number (the counter is unchanged).

## S6 (LATER; gated on the production recode reading 0): a database CHECK on the shape
- Gate: after `--apply` on production, `SELECT count(*) FROM items WHERE NOT (code ~ '^[A-Z0-9]{4}-[0-9]{3}$' AND
  right(code,3) <> '000');` = **0** with Ian, recorded in `docs/ops/README.md`.
- Tester: a fixture helper `testItemCode()` (unique shaped codes, e.g. `T` + 3 random base-36 characters + a 3-digit
  sequence) and the sweep of every raw `insert into items` and `insertItem(` test site (~120). Builder: migration (number
  allocated then) adding `items_code_shape_check`, its schema `check()` and a constraint sentence (= R5 shape sentence).
- Full suite on a fresh gate DB. Not part of this PR.

## Rollout and prechecks (0189)
**Header block** (the builder copies into 0189; READ ONLY, `BEGIN READ ONLY; ... ROLLBACK;`, as `doadmin` with Ian
before the push):
```
-- P0189a  SELECT org_id, status, count(*) FROM items GROUP BY 1, 2 ORDER BY 1, 2;          -- informational: what the recode touches
-- P0189b  SELECT count(*) FROM items WHERE code ~ '^[A-Z0-9]{4}-[0-9]{3}$';                 -- informational: already shaped, kept and seeded (expect 0)
-- P0189c  SELECT org_id, upper(code), count(*) FROM items GROUP BY 1, 2 HAVING count(*) > 1;
--         -- MUST be 0 rows: the new UNIQUE (org_id, upper(code)) cannot be built over a case-twin. If any, rename one
--         -- through Rename on the item page (T-383) before the push.
-- P0189d  SELECT count(*) FROM items WHERE code <> upper(code);                              -- informational: lower-case legacy codes
-- P0189e  SELECT count(*) FROM item_requests WHERE status = 'requested';                    -- informational: pending requests keep a typed code as their preview; approval allocates
```
**`docs/ops/README.md` row:** `| 0189 (T-386) | READ ONLY, as doadmin with Ian before the push (SQL in the 0189
header). P0189a item counts; P0189b shaped codes (seeded); **P0189c MUST be 0 rows**; P0189d lower-case codes; P0189e
pending requests. Must run as doadmin (the seed needs row_security = off) | (results). After deploy expect one more row
in drizzle.__drizzle_migrations than after 0188 (170 if 0188 landed as 169). Then: recode dry run with Ian, --apply,
post-check = 0 non-shaped (gates S6) |`.
**After deploy:** `npm run recode-items -- --org=<id> --actor=<Ian's person id>` (dry run) on production with Ian; read
the list together; `--apply`; post-check (S6 gate query) = 0. Count sheets printed before the recode carry old codes;
tell the stores the next printed sheet has the new ones.

## Done when
- S1-S5 committed, each slice tester-red then builder-green (red shown against HEAD or the named mutant); full suite
  green in CI on the PR; typecheck 0; `npm run build` 0 with the dev server stopped; touched files LF.
- 0189 applies from zero (CI) and on a scratch DB (ADR-012 §5.8); journal, trigger-registry, RLS-registry and
  classification guards green.
- `docs/ops/README.md` 0189 row written; P0189a-e run with Ian before the push.
- The proposed DEF marked fixed with the S3 commit; GLOSSARY gains **item code** (*"`CHWN-001`: 4 characters from the
  name by the T-386 rule + a number never issued twice under those 4; display-only, nothing joins on it"*) and
  **stem**; CAPABILITY-MATRIX `approve_item` note gains *"T-386: sets or overrides an item code"*, `manage_items` note
  *"T-386: sees the suggested code (read-only)"* — the builder of S4 edits both docs.
- §9.4 smoke done, screenshots named in the S4 commit.
- Bible §13 row for Ian's four answers: the orchestrator's (RULES §1 rule 14).

## §9.4 smoke (port 9008, `docs/SMOKETEST.md`)
1. As a manager on `/items`, type "Chicken wings": the code box shows `CHWN-…` then `CHWN-001`; no editable code field.
   Request it. Type "Chicken winglets": the amber line lists nothing yet (the request is not an item). Screenshot.
2. As super-admin: approve the request -> "Approved as CHWN-001." Type "Chicken winglets" in the form: `CHWN-002` and
   the amber "Already coded CHWN: CHWN-001 Chicken wings". Add directly -> `CHWN-002`. Screenshot.
3. Add "Coke 1.5" with "Use a different code" = `ck15-005` -> stored `CK15-005`. Try `CK15-003` -> the red sentence
   naming the next free one.
4. Open Chicken wings, Edit, rename to "Chicken wing tips": the suggestion reads `CHWT-001`; leave the tick off, Save ->
   code stays `CHWN-001`. Edit again, tick, Save -> `CHWT-001`. Screenshot of the section locked and unlocked.
5. Turn JavaScript off: the form still submits; the item gets the next code ("Filled in when saved").
6. `npm run recode-items -- --org=... --actor=...` on the dev DB: the dry-run list, then `--apply`, then a second dry run
   shows 0.
7. psql as the app role: `UPDATE items SET code='CHWN-001' WHERE code='CHWT-001'` -> 23514 `items_code_never_reused`.
8. Phone width (375px) and dark mode: the code box, the amber line and the override input wrap; no horizontal scroll.

## Out of scope (each with a reason)
- **A kind prefix** (`RM-CHWN-01`): Ian chose (b).
- **A check digit:** every code entry here is a picker or search; a scanned barcode carries its own check.
- **Barcodes / supplier EANs:** a different identifier; a future `item_barcodes` table, never the code. v2 has no
  barcode column; the new codes are valid Code 39/128 strings, so labels can carry them later.
- **POS changes:** POS maps by uuid (`pos_item_maps.item_id`); nothing in POS reads the code.
- **Codes changing automatically on rename:** q4 = a (offer, never automatic).
- **Editing kind** (T-383 N1): unaffected; the code has no kind in it, so a kind change could not stale it anyway.
- **Rewriting `item_requests.code` of decided requests** to the minted code: the request's `created_item_id` already
  points at the truth; the stored preview stays as written (it is the requester's frozen screen, like `similarWarning`).
- **S6's shape CHECK in this PR:** R12.
- **Label printing:** none exists yet.

## Questions only Ian can answer
None blocking. Ian's four answers (2026-10-09) are built as written. One consequence to tell him, not ask: under
q2 = a, an override must use a number above everything already issued under those 4 characters, so a super-admin
cannot pick `CK15-001` once `CK15-001` has ever existed — that is "never reused" applied to the override too.
