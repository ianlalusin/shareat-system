# T-443: Item variations, "not a duplicate" dismissal, kind filter, two duplicate guards, wholesale label

**Status:** BUILT and locally audited 2026-10-19; release requires green full PR CI. Spec 2026-10-18. Ian's request the same day; his two rulings recorded below (bible rows to add at wrap-up).

## Why

Ian, 2026-10-18 (verbatim):
> lets make item with variations like kimchi it must have variations 10kg, 250g 500g
> look like the same item must be able to dismiss so the user can say Samyang cheese and Samyang 4 cheese cant be merge coz they are totally different items
> make the table filterable by kind add guard to keep item from being duplicated on request and on approval by admin 2 guards set up
> inspect if shold wholesale means sold to other store and label correctly

Measured before writing (research 2026-10-18):
- Neither v1 nor v2 has item variations. v1 keeps each size as a separate item; v2 has only `purchase_unit`/`purchase_factor`
  (a buying container) and `parent_slab_item_id` (slab → slices, not sizes). `menu_item_variants` is the MENU side and is not this.
- The look-alike panel (`findDuplicateCandidates`, pg_trgm ≥ 0.5) offers MERGE only. No way to say "these are different", so a
  real pair (Samyang Cheese / Samyang 4 Cheese) shows forever, and so would every sibling size (Kimchi 250g / Kimchi 500g).
- Guards today: the DB's `items_org_name_key` (lower(name)) refuses a second item at approval, but only as a raw unique
  violation AFTER a code has been allocated. A request for a name that already exists is accepted; two identical pending
  requests are accepted.
- Wholesale: in practice `sellable_wholesale` means "sold to another store, a franchisee or an outside buyer (e.g. Xlice)",
  i.e. not to a diner. v1 called this commissary → branch sales (`computeBranchPrice`) plus the Xlice channel. v2's labels
  say "Sold wholesale" and "Sold wholesale / to franchisees", leaving out the commonest case (Lipa → its own branches).

## Ian's rulings (2026-10-18)

- **R-A Variations = their own items.** Each size is a full item (own code, stock, price history), grouped under a parent.
  Not pack sizes of one kg pool. (Rejected: one item with pack-size conversions — cannot count "12 jars of 250g".)
- **R-B Wholesale label = "Sold to other stores or buyers (wholesale)".** Meaning unchanged, no schema change. (Rejected:
  splitting into two flags — needs a DB change and touches trade orders.)

## Requirements

### R1 Variations (one level)
- New nullable `items.variant_of_item_id uuid` → another item in the same org (same-org composite FK, ON DELETE RESTRICT).
- Rules, enforced in the DATABASE (trigger `items_variant_guard`, BEFORE INSERT OR UPDATE OF variant_of_item_id, kind, status)
  and mirrored in the domain with plain-English errors:
  1. Not itself (`CHECK variant_of_item_id <> id`).
  2. One level: the parent must have `variant_of_item_id IS NULL`, and an item that has variations cannot become a variation.
  3. The parent is not `merged`. (An inactive parent is allowed — retiring the family header must not orphan anything.)
  4. Same `kind` as the parent. A parent may not change kind while it has variations.
- Each variation keeps its full name (e.g. `Kimchi 250g`); the name stays unique as today. No separate label column.
- Setting/clearing it: new domain fn `setItemVariantOf(tx, actor, { itemId, parentId | null })`, capability `approve_item`
  (same as merge — it changes how the catalogue is grouped). Audit like the other item admin writes if they audit.
- Requests: `item_requests.variant_of_item_id` (nullable, same FK shape). Request form gets an optional
  "Variation of" select (live, non-merged, top-level items). Approval copies it; the approver may change or clear it.
- Merge: `mergeItems` refuses when the LOSER has variations ("move or detach its variations first"). A variation may be merged.
  Merging into a winner keeps the winner's own parent.

### R2 Dismiss a look-alike pair
- New table `item_duplicate_dismissals` (org-scoped): `id`, `org_id`, `item_a_id`, `item_b_id` (`CHECK item_a_id < item_b_id`,
  both same-org FKs to items), `note text NULL`, `dismissed_by` (same-org person FK), `dismissed_at timestamptz default now()`.
  `UNIQUE (org_id, item_a_id, item_b_id)`. RLS via `app_current_org()`; grants SELECT, INSERT, DELETE (undo).
- `findDuplicateCandidates` excludes: dismissed pairs; and pairs in the same family (parent↔variation, sibling↔sibling) —
  sizes of one product are expected to look alike.
- Domain `dismissDuplicatePair(tx, actor, { itemAId, itemBId, note? })` (orders the ids itself; idempotent on conflict) and
  `undoDuplicateDismissal(tx, actor, { dismissalId })`. Capability `approve_item`.
- Panel: each pair gets a third button **"Different items — stop asking"** (optional note). Below the panel, a collapsed
  `<details>` "N pairs marked as different" listing them with **Undo**.

### R3 Filter by kind
- `/items?kind=<ITEM_KINDS value>` filters the table (server-side, via `listItems` filter). A row of links/chips:
  "All · Raw material · Supply · Retail item · Meat (slab) · Meat (sliced)" with counts; the active one highlighted.
  An unknown `kind` value is ignored (shows all). Variations render indented directly under their parent; when filtering,
  a variation whose parent is filtered out still shows (flat).

### R4 Guard 1 — at request time (`requestItem`)
- Name normalisation for ALL item/request name writes (create, request, rename): trim + collapse internal whitespace.
- Refuse (throw, plain English) when an item with the same name ignoring case exists — any status. Name it, with its code,
  and say what to do: inactive → "reactivate it"; merged → "it was merged into <winner>; use that".
- Refuse when an OPEN request (`status = 'requested'`) with the same name ignoring case exists: "<who> already asked for
  this on <date>; it is waiting for a super-admin."
- DB backstop: partial unique index `item_requests_open_name_key ON item_requests (org_id, lower(name)) WHERE status = 'requested'`.
  The action maps its violation to the same message.

### R5 Guard 2 — at approval time (`approveItemRequest`, and `createItem`)
- Before allocating a code, re-check the name against items (any status) ignoring case; refuse with the same message as R4
  and leave the request `requested` (the approver rejects it with a note). `items_org_name_key` stays the backstop; the
  action's existing mapping covers the race.
- The look-alike warning stays advisory (never blocks): Coke 1.5 vs Coke 15 rule stands (T-148).

### R6 Wholesale label (R-B)
- `items/page.tsx` approve row checkbox → "Sold to other stores/buyers"; create form → "Sold to other stores or buyers
  (wholesale)" with hint "our own branches, franchisees, outside buyers like Xlice — not diners".
- `items/[id]/page.tsx` label → same wording. `soldAsLabel` keeps the short word `wholesale`.
- `docs/GLOSSARY.md`: add **wholesale (item flag)** entry with the meaning above.
- No schema, domain or trade-order change.

## Migration `0210_t443_item_variations_dismissals.sql` (ADR-012 §5)

Hand-authored. Contains: `items.variant_of_item_id` + same-org FK + not-self CHECK + index; `items_variant_guard` trigger fn;
`item_requests.variant_of_item_id` + same-org FK; `item_requests_open_name_key` partial unique index; table
`item_duplicate_dismissals` + RLS + policy + grants (SELECT, INSERT, DELETE). Schema files carry `// NOTE: hand-added in
migration 0210` beside what Drizzle cannot say. Register the new table in `rls/registry.ts` and `cutover/classification.ts`.
Journal on the grid. Proven on a scratch DB. Existing duplicate open requests: the index creation must not fail — the migration
first sets later duplicates of an open request to `rejected` with `decision_note = 'T-443: duplicate of an earlier open request'`
(count them first; expected 0).

## Tests (integration, run on any `_test` DB — never lane-pinned)
- Variation: set/clear; refusals for self, two levels, parent with variations, merged parent, kind mismatch — at domain AND
  with a raw UPDATE (trigger fires). Approval copies `variant_of_item_id`.
- Merge refuses a loser with variations.
- Dismiss: pair disappears from `findDuplicateCandidates`; idempotent; undo brings it back; siblings never listed.
- Guard 1: existing-name refusal (active / inactive / merged messages); open-request refusal; raw INSERT hits the partial index.
- Guard 2: approval refuses an existing name and the request stays `requested`; no code counter consumed.
- Kind filter: `listItems` with kind returns only that kind.
- Every new ✅ capability use has its ✗ test (non-super-admin refused for set-variant, dismiss, undo).

## Audit addendum — 2026-10-19

The raw trigger must serialize concurrent family changes: opposite assignments must not form a cycle,
and attaching a variation must not race a parent's kind change or merge. Add real two-connection tests
before the correction. Migration 0210 has already been applied to scratch/dev and is immutable; any
correction is forward migration 0211 plus its journal entry. Add these paths and the existing integration
file to scope. Also include the advisory-lock key list/schema/trigger comments and the action race test
`apps/erp/tests/t443-request-race.test.ts`: wrapped database errors must retain the mapped sentence, and
a request losing the unique-index race must name the winning requester/date after a fresh permission check.
Keep the domain's early sentences and database enforcement. Record the two audited defects in
`docs/DEFECTS-REGISTER.md` (DEF-678/679). Add real provocation coverage for all three new constraint keys
in the two `apps/erp/tests/integration/constraint-message-lookup*.test.ts` files and update the T-383 web
expectation to the new contextual name refusal. These integration paths are included in scope. Record the evidence in `docs/reviews/t443-t444-audit.md`.

## Done when
Typecheck, lint, unit + the items integration tests green locally; the page is checked in the browser (filter chips, a family
indented, dismiss + undo, both guards' messages, new wholesale wording) with a screenshot.
