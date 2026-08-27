# T-129 — Customers and price lists

> **Status:** SPEC, 2026-08-27. Written before implementation (bible §1.2a).
> **Decided by:** ADR-008 §2 (one table, two links), §3 (price lists), §11 (retail diners are not
> customers). This task builds what the ADR already settled — it does not re-open it.
> **Defect it fixes:** DEF-075 — a stored `outstandingBalance`, for the fifth time.

## 1. ⛔ The line that matters: a retail diner is NOT a customer

> **ADR-008 §11:** *"A `customers` row exists because there is a BALANCE or a credit relationship.
> A diner who pays at the point of sale has neither."*

| | Wholesale buyer | Retail diner |
|---|---|---|
| Resto **or** individual | Either — irrelevant | Individual |
| Pays | On terms, later | **Immediately** |
| Creates a receivable | **Yes** — an AR party with a subledger balance | **No** |
| Belongs in `customers` | **Yes** | ⛔ **No** — a loyalty/profile record in the CUSTOMER app |
| Sale posts | `DR 1210 AR (party)` / `CR revenue` | `DR cash-or-online` / `CR revenue`, **no party** |

⚠️ **The test is not org-vs-individual.** An individual who buys meat on terms IS a customer; a
company that pays cash at the counter is not. **The question is whether a balance exists.**

⭐ Nothing in this task touches à la carte orders. Those stay on the Website, per store, and the
diner behind them is a loyalty profile in another app.

## 2. One table, two links, and the treatment is DERIVED

ADR-008 §2, unchanged:

| | Treatment |
|---|---|
| `counterparty_store_id` set (one of our own stores) | **Internal transfer — eliminates.** Not revenue |
| `counterparty_org_id` set (another org — a franchise) | **Inter-entity sale — real revenue** |
| neither | **External sale — real revenue** |

⭐ **Deriving is right here**, unlike `normal_balance` (bible row 39) which is declared. That one was
inferred from a *string prefix* — a guess about a name. This is a **foreign key**: the counterparty
either is one of our stores or is not, and the join answers it with no interpretation. ⛔ A declared
`is_internal` flag beside the link would be a second copy of the same fact, free to drift silently.

⚠️ **`customer_group` NEVER drives accounting.** Reporting and default price lists only. If it ever
gates a posting decision, that is the bug this line exists to prevent.

### ⭐ v1 already has the internal link, which is why this is a re-platform and not an invention

`ARCustomerPlain.linkedStoreId` — *"when the owning store has `storeKind === 'commissary'`, this
points to the branch store this AR customer represents."* Same idea, narrower: v1 can only express
*"one of our stores"*, and has no way to say *"another company"*, because v1 models a franchise as a
branch (ADR-008 §7).

## 3. ⛔ DEF-075 — `outstandingBalance`, the fifth time

`ARCustomerPlain.outstandingBalance` is a stored number beside a ledger that already knows.
Loans (row 158), owner equity (DEF-072), cash requests, liabilities (DEF-074), now this.

⭐ Here it is summed from `1210` by party, exactly like every other control account. **This task
does not build AR** — that is T-131 — but the customer's balance is derived from day one, so there
is never a column for T-131 to have to remove.

## 4. ⭐ The reconciliation anchor — worth porting, and it fits v2 better than v1

v1 stamps `reconciledAsOfDate` when a customer is *"verified at zero outstanding"*, and
*"everything before this date is considered settled."*

⭐ **That is a genuinely good idea**, and it fits v2's zero-starting-point exactly: it is how an
aging report begins without migrating history. Ported as `reconciled_as_of`, `reconciled_at`,
`reconciled_by`.

⚠️ **It is an attestation, not a balance** — the same shape as T-127's drawings close. It says *"on
this date, this person agreed this customer owed nothing"*, and it does not change when the ledger
does. That is what makes a later disagreement visible.

## 5. Price lists — the ERPNext shape, and nothing more

`price_lists` (a named list) + `price_list_items` (per-item rates). A customer names a default; an
order line takes the rate and may override it, with the override recorded.

⛔ **Out of scope, and named so the omission is a decision:** pricing *rules* — volume breaks,
date-ranged promotions, customer-group discounts. ADR-008 §3 already says so: *"ERPNext's full
Pricing Rule engine is exactly the generality bible §1.1 says to leave out until something needs
it."*

### ⚠️ `item_code` is opaque text, because there is no item master yet

There is no products/items table in v2. Same precedent as `expenses.supplier_id` — *"Opaque text,
not a FK — no suppliers table exists until Wave 3."* ⛔ It becomes a foreign key the day an item
master lands, and the column comment says so.

## 6. Scope

**In.** `customers` · `price_lists` · `price_list_items` · the derived treatment · the derived
balance · the reconciliation anchor · screens.

**Out:**

- ⛔ **Orders.** T-132 (wholesale orders) owns the document that uses a price list.
- ⛔ **AR postings and aging.** T-131.
- ⛔ **Pricing rules** — §5.
- ⛔ **Inter-entity posting of both sides.** ADR-008 §4, and it needs T-133.

## 7. Done when

- [x] `customers`, `price_lists`, `price_list_items` in the schema, classified in
      `cutover/classification.ts` **and** registered in `rls/registry.ts`.
- [x] Integration tests: ⭐ **the treatment is derived from the links, and both links at once is
      refused**; ⭐ **the balance comes from `1210`, and no column stores it**; a price list rate is
      found for an item; the reconciliation anchor records who and when.
- [x] Screens, driven end to end in a browser.
- [x] Gates: typecheck · unit · integration · build.

---

## 8. Verified in a browser, 2026-08-27

Recorded a customer linked to one of our own stores. The register showed
**"Internal — eliminates, not revenue"** with the store's name beneath it, a derived balance of
₱0.00, and an anchor control. Created a price list, set PORK-BELLY at ₱380/kg, then re-quoted it at
₱410 — **one row, replaced**, not two.

⭐ **The form offers ONE counterparty picker, not two.** Two independent dropdowns would let someone
fill both, and the entire design rests on a customer having at most one. The service and a CHECK
both refuse it anyway; the UI simply never offers the mistake.

### ⛔ A bug the browser found: a re-quote blanked the label

Re-pricing an item the normal way — a code and a number — came back as a bare `PORK-BELLY` at
₱410 with **"Pork belly" and "kg" gone**. The upsert overwrote `item_name` and `unit`
unconditionally, so omitting them meant erasing them.

⭐ Now the RATE always replaces — that is what a re-quote is — while the label and unit only replace
when a new one is supplied. Pinned by a test.

## 9. Still not done

- ⛔ Everything in §6's out-list: orders (T-132), AR postings and aging (T-131), pricing rules,
  and ADR-008 §4's both-sides inter-entity posting (needs T-133).
- ⚠️ **`item_code` has no item master to validate against.** A typo creates a rate nothing will ever
  match, silently. It becomes a foreign key the day an item master lands.

