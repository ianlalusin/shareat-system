# T-617: gate the 13 routes that awaited a decision

**Owner:** builder (Sonnet). An auth auditor (Sonnet) reviews it. **Spec:** BOSS (Opus), 22 Nov 2026.
**Ian, 22 Nov 2026:** "approve the defaults" for the table below.
**No migration and no new capability:** each route uses capability words that already exist. Find the exact words in `packages/auth` and `docs/decisions/CAPABILITY-MATRIX.md`.

| Route | Who may open it (Ian's approved default) | Use the existing word(s) for |
|---|---|---|
| `/attendance` | managers and admins | managing or adjudicating attendance |
| `/attendance/leave` | **everyone** for their own leave (request, see own); managers see and act on their store's | the page keeps its own-leave view open to any signed-in staff, and the store list needs the leave-approval word |
| `/channel-settlements`, `/channel-settlements/record` | people allowed to record settlements | recording a channel settlement |
| `/commissary/catalogue` | commissary staff, managers, admins | managing the commissary catalogue / prices |
| `/commissary/discrepancies` | commissary staff, managers, admins | resolving commissary discrepancies |
| `/commissary/orders` | commissary staff; branch managers for their own store's orders | fulfilling commissary orders, or creating branch orders (store-scoped) |
| `/items`, `/items/import` | people who manage the item list | managing or approving items |
| `/opening-balances` | admins only | the opening-balance / cutover word (admin only) |
| `/statutory-discounts` | managers and admins | viewing the SC/PWD register |
| `/trade/orders` | wholesale staff and managers | creating or approving wholesale orders |
| `/franchise` (actions) | franchise viewers | `view_franchise_sales` (already checked in the domain) |

## Build

- Move each route from `ROUTES_AWAITING_A_DECISION` into the route map (`apps/erp/src/lib/route-capability.ts`) with its words. The awaiting list ends **empty**; keep the export but empty, with a comment.
- Each page calls the house gate (`requirePageAccess`, or `storePageScope` / `recordInScope` for store-scoped pages, as T-603 did).
- `/attendance/leave` keeps a signed-in person's **own** leave view open (no word needed). Store-wide lists need the word.
- **No staff position loses a screen it acts on today.**
  - Check every position default (Cashier, Server, Kitchen Staff, Inventory Staff, Commissary roles) against each route.
  - List before and after per position in the hand-back.
  - A position that **acts** on a page today (holds its write word) must still reach it.

## Tests

- For each route: someone with the word is allowed, someone without it is refused, and an admin sees it.
- For `/attendance/leave`: a staff member without the word sees their own leave and not others'.
- `/opening-balances` refuses a manager.
- **Mutant:** drop one route's gate → red.
- **Pins:** route-capability coverage (the awaiting list is empty), no-ungated-read-surface, t577, t616, touch census (via `npm run census:write`), and the t343 auth census.

## Out

- New capabilities: none needed.
- Store-scoping of the data inside these pages beyond the gate: only where T-603's helpers apply directly.
