# T-520 — Supplier invoices: one table, status in columns

Status: SPEC (Opus), 2026-11-05. Ian (with screenshot of /ap): "i dont like that invoices page i want 1 table only
with all needed status on the columns. sort it by date recent first. pills for status, not verified, open (not fully
recorded) etc. /impeccable redesign the page". Impeccable: refinement of an existing Operate-mode surface — keep the
ERP's identity and kit; precision and restraint.

## Today (main)
`apps/erp/src/app/ap/page.tsx`: an amber banner listing the pending invoices ("2 invoices need verification"), then a
second table (Supplier, Invoice no., Date, Status, Total) with one Status pill (+ a "Verified by its own creator"
pill). The same invoices appear twice; "recorded" and "paid" are invisible until you open each invoice.

## Design
One table, newest first (`invoiceDate` desc, then `createdAt` desc). Columns, left to right:

| Column | Content |
|---|---|
| Date | `YYYY-MM-DD`, tabular |
| Supplier | supplier name — the row link to `/ap/invoices/[id]` (keep the existing RowLink/LinkRow pattern) |
| Invoice no. | as today |
| Verified | pill: **Not verified** (warning) · **Verified** (success) · **Voided** (closed). A self-verified invoice adds a second small warning pill **Self-verified** (today's "Verified by its own creator", shortened) |
| Recorded | pill: **Not recorded** (warning) · **Open · ₱X left** (progress) · **Fully recorded** (success). Voided → muted "—" |
| Paid | pill: **₱X owed** (warning) when anything recorded against it is still unpaid · **Paid** (success) when fully recorded and nothing owed · muted "—" when nothing is recorded yet or voided |
| Total | right-aligned peso, tabular (as today) |

- The amber "N invoices need verification" banner list is removed — the Verified column carries it.
- Keep: the page header and its "+ Log invoice" FormModal, the cross-links, the FlashBanner, the
  "Verified by its own creator →" filter link (relabel "Self-verified only →" / "Show all invoices →"), the empty state.
- Pills use the kit `Badge` (tone + label); never colour alone (Badge already pairs dot + word). Money via the
  existing `peso`. No new colours; no `text-neutral-300/400` (T-514 guard).
- Use the kit `Table` / `Th` if it fits without losing the phone-card behaviour (T-450); otherwise keep the raw table
  but give `<th scope="col">` and an sr-only caption "Supplier invoices".

## Data (read-only)
- "Recorded" and "Left" = what the invoice detail page already shows (`/ap/invoices/[id]`: Recorded / Remaining from
  the expenses capacity query). "Owed" = the same outstanding the detail page uses for open items per
  `supplierInvoiceId`. Reuse those repo functions; compute for ALL listed invoices in bulk (one query or one grouped
  query each) — no per-row query. The bulk SQL lives in `packages/db/src/repo/` (SQL only there, per bible); `apps/erp/src/app/ap/lib.ts` calls it. No migration, no
  posting, no domain rule change.

## Contract
No behaviour change beyond the drawing and the added read-only columns. Same permissions, same actions, same
filter. Every number shown already exists on the invoice's own page; the list must agree with it.

## Verification
Typecheck; unit + affected integration tests (grep tests for `/ap` page assertions, e.g. "need verification",
"Verified by its own creator", and update only assertions that read the old drawing); a test that the list's
Recorded/Left/Owed equal the detail page's numbers for a partly-recorded, fully-recorded-unpaid, paid and voided
invoice; rendered Impeccable critique + detector at 1440 and 390 with screenshots.

## Keeping the "needs verification" signal (BOSS)
Above the table, beside the self-verified filter, a filter link **Not verified (N) →** (`?status=pending`, a flag —
no typed value in the URL) that lists only unverified invoices; hidden when N = 0, and "Show all invoices →" when
active. N comes from the same rows. Census/baseline changes (action-link, touch-target, t450 table census) are
re-measured and listed for BOSS approval. Task T-520 (BOSS, 5 Nov); branch `t520-ap-one-table` in `wt-t448-sweep`.
