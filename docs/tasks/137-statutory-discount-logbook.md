# T-137 — The SC/PWD statutory discount record

> **Status:** requirement captured 2026-08-25 · **re-assessed and corrected 2026-08-29** under
> `/research-evaluate-propose`, then scheduled.
> **Decided:** bible rows 131, 132 · **Evidence:** `docs/discovery/24-cash-custody-and-statutory-discounts.md` §4
>
> ⚠️ **This spec was rewritten because its central factual claim was wrong.** The 2026-08-25
> version said the ID number is *"✅ captured today"* and that POS *"already asks for the ID, so the
> flow exists; it is being widened."* **Verified at source 2026-08-29: nothing captures an ID
> number, in any of the four reference repos.** What that changes is recorded in §1 — it is the
> difference between widening a flow and building one.

---

## 1. ⚠️ The correction, and why it matters

Bible row 132 records Ian's *"today the business captures only the ID"*, and the previous spec read
that as **stored data**. It is not. Read at source:

| Where | What is there |
|---|---|
| `POS/src/lib/types.ts:813` — `Discount` | `vatExempt?: boolean` on the discount **definition**. No ID field, no holder-name field, nowhere to put one |
| `POS` — whole repo | The only `OSCA-…` string is placeholder text in `.design-sync/previews/Popover.tsx:16`, a component preview. Not a code path |
| `ERP-rebuild`, `CUSTOMER`, `Shareat Website` | No SC/PWD identity capture at all |

**The honest reading of row 132 is that the cashier looks at the ID card** — a counter practice that
leaves no record. So the two statutory identity fields are not being *widened* from an existing
flow; they have never existed anywhere, and they are precisely the two fields **no amount of
derivation can produce**, because they are typed by a human who is looking at a physical card.

### ⭐ And the inverse of the old table is true: the other four fields already exist

`POS/src/lib/types.ts:1570` — `DiscountEvent` is written **per transaction** and already carries
`receiptId`, `receiptNumber`, `discountName`, `amount`, `createdAt`, `createdByUid`,
`createdByName`, `createdByRole` and a free-text `reason`.

**So POS is missing two fields, not five.** The old spec had it backwards.

---

## 2. What the regulation actually requires

⚠️ **Two regulations, not one.** RR 5-2017 is **PWD only**; the senior half is **RR 7-2010**
(RA 9994). The previous title cited RR 5-2017 for both.

Both require the same record — [RR 5-2017 §5.9](https://ncda.gov.ph/disability-laws/implementing-rules-and-regulations-irr/revenue-regulations-no-5-2017-rules-and-regulations-implementing-republic-act-no-10754/)
and [RR 7-2010](https://elibrary.judiciary.gov.ph/thebookshelf/showdocs/10/55830), *"separate and
accurate records of sales"*, per transaction:

| # | Field | Reg text | Where it can come from |
|---|---|---|---|
| 1 | Name of the SC/PWD | ✅ both | ⛔ **human entry only** |
| 2 | ID number — **OSCA ID** (senior) / **PWD ID** (PWD) | ✅ both | ⛔ **human entry only** |
| 3 | Gross sales/receipts | ✅ both | POS `DiscountEvent` / receipt |
| 4 | Sales discount granted | ✅ both | POS `DiscountEvent.amount` |
| 5 | Date of transaction | ✅ both | POS `createdAt` |
| 6 | **Invoice number** | ✅ both | POS `receiptNumber` |

⛔ **Field 6 was missing from the previous spec.** It is in the regulation text of both.

⚠️ **"Establishment signatory" is NOT reg text.** It appears in practitioner guidance, and the
previous spec listed it as a requirement. The reg-level signature is the **customer's**
(RR 10-2015) — and [RR 8-2023](https://www.ocamposuralvo.com/2023/09/08/bir-issues-regulation-for-senior-citizens-and-pwds-to-avail-of-discounts-for-online-transactions/)
**waives even that for online and mobile-app orders**, requiring only that the ID number be
supplied. It is modelled here as a nullable column, because a cautious establishment keeps it and
the regulation does not compel it.

**One discount only** — a PWD who is also a senior claims one 20%, not both. Enforced here by
construction: one row per invoice, and `kind` is a column on it.

---

## 3. ⛔ The constraint that shapes this: bible row 75

> *"Shareat System must never be labelled or exported as BIR-ready output. A statutory basis, if
> ever needed, is **a separate reporting layer over the same ledger — not a retrofit of these
> accounts**."*

Row 75 does not block this record. **It dictates its shape**, and the shape it dictates is the one
T-137 already wanted — *"a parallel record, not a replacement"*:

- ⛔ **No journal impact.** This table posts nothing. The daily `seniorDiscount`/`pwdDiscount` on
  `sales_days` continue to 4900 exactly as they do now (bible row 132).
- ⛔ **No VAT engine, no VAT recomputation.** `gross` and `discount` are recorded as the till
  computed them. This system does not compute a VAT exemption and must never present one.
- ⛔ **No change to the 4900 treatment.** The tax-versus-financial-reporting tension in discovery 24
  §4(b) is real and remains Ian's decision with an accountant. Confirmed from the reg text, which
  does say the discount is *"a deduction from gross income"* and *"a necessary and ordinary expense"*
  — but a management ledger is not the place that argument gets settled.
- ⚠️ **The report carries the row-75 disclaimer on its face.** It is a business record kept in
  support of a statutory obligation; it is not a BIR return and is not labelled as one.

---

## 4. Scope

### In

1. `statutory_discount_records` — one standalone table, the six reg fields plus provenance.
2. Repo + domain: create, list, void. **Void, never delete** — a statutory record that can be
   silently removed is worthless as evidence.
3. ERP surface: an entry form and a logbook report filtered by store and date range.
4. Registry entries: cutover classification, RLS scoping, capability.

### Deliberately out, each with a reason

| Out | Why |
|---|---|
| **POS capture of name + ID** | `POS` is a read-only reference repo (bible §2 rule 1) and Ian decided 2026-08-25 *"don't touch v1, let it be."* **Impossible now, not merely deferred** — it lands with POS v2 after January |
| **Firestore ingest of `DiscountEvent`** | The hot set in bible §5.3 is a **closed list** and adding to it *"requires a bible amendment (§14)"*. The four derivable fields stay manual until that amendment exists. **Flagged, not assumed** |
| **Any VAT computation** | Bible row 75. This is a management ledger |
| **Any change to 4900** | Bible row 132 settled it; the tax tension is Ian's with an accountant |
| **Deriving the daily `sales_days` split from these rows** | They are two records with different provenance and different completeness. Making one depend on the other couples a statutory side-record to revenue recognition, and row 75 says the statutory layer sits *over* the ledger, never inside it |

---

## 5. Provenance — the column that keeps this honest

`source` is `'transcribed' | 'pos'`.

Every row is `transcribed` until POS v2 exists. **This is the same lesson as `sales_days.posSourced`**
(T-123): *"a day pulled from POS and a day typed in by hand are not equally trustworthy, and a
reader that cannot tell them apart will treat them as if they were."* When POS v2 lands it writes
`pos` rows into this same table, and the report can then show which period is machine-captured and
which was typed from the paper book — without a migration.

---

## 6. ⚠️ The honest risk: this table may stay empty

**Utilisation is unknown and I could not reach the number.** I would want the count of receipts
carrying a `vatExempt` bill discount per month; it lives in POS Firestore (`receipts`,
`discountEvents`), which is not queryable from the build environment. **v1 offers no proxy, because
`seniorDiscount`/`pwdDiscount` are hardcoded to `0` on the only live write path**
(`ERP-rebuild/src/app/financial/sales-report/new/page.tsx:342`; bible §16.7 defect 3 — already
known, independently re-verified 2026-08-29).

So the value of this table rests on a question only Ian can answer, and **discovery 24's Open 1 is
still open**:

> **Is a paper SC/PWD logbook kept at the store today?**

- **If yes** — this is digitisation. A manager transcribes the book; the obligation is already
  being met and this makes the record durable, searchable and reconcilable against the daily totals.
- **If no** — the obligation is being missed today, and this table is the first place it is met.
  That is a **process** change before it is a software one, and shipping the table alone will not
  achieve it.

**Either way the table is the same**, which is why it is being built before the question is
answered. What the answer changes is whether anyone fills it.

---

## 7. Open

1. ⛔ **The paper-logbook question above** (discovery 24 Open 1) — unanswered since 2026-08-25.
2. **Does POS enforce one-discount-only today**, or is it left to the cashier? Not answerable from
   the reference repos: the `Discount` type has a `stackable` flag but no senior/PWD-specific
   exclusivity rule. v2 enforces it on this record by construction regardless.
3. **The 4900-versus-expense treatment** (discovery 24 §4b) — Ian + accountant. Unchanged here.
