# T-137 — The senior/PWD discount logbook

> **Status:** requirement captured 2026-08-25, **not scheduled.** Recorded because a compliance
> obligation that lives only in a conversation is one nobody will act on.
> **Decided:** bible row 132 · **Evidence:** `docs/discovery/24-cash-custody-and-statutory-discounts.md` §4

## What it is

**RR 5-2017 requires a separate PWD discount logbook**, kept **per transaction**:

| Field | |
|---|---|
| PWD / senior ID number | ✅ **captured today** |
| Name | ⛔ not captured |
| Date | derivable |
| Original amount · discounted amount | ⛔ not captured per transaction |
| Establishment signatory | ⛔ not captured |

Ian, 2026-08-25: *"No, we only require the ID. Since you mentioned it — yes, we can require the
logbook too."*

**Sales to SC/PWD are VAT-exempt, and the burden of proof in a BIR audit is on the seller.**

## ⛔ Why this cannot be an ERP feature

**Only POS holds transaction-level detail.** The ERP's sales day carries `seniorDiscount` and
`pwdDiscount` as **daily totals**, and no amount of ERP work reconstructs a name that was never
recorded at the till.

> **This is a POS CAPTURE requirement with an ERP REPORTING surface.** The two halves cannot be
> swapped, and building only the reporting half produces an empty report.

## What it touches

- **POS** — capture ID, name and the per-line original/discounted amounts at the point the
  discount is applied. It already asks for the ID, so the flow exists; it is being widened.
- **ERP** — the logbook report, and the audit surface.
- **T-123** — the daily `seniorDiscount` / `pwdDiscount` totals stay as they are (they post to
  4900, bible row 132). **The logbook is a parallel record, not a replacement**: one is for the
  books, the other is for the BIR.

## Sequencing

⚠️ **This is a live obligation, not a v2 feature.** POS v2 is a phase after January
(discovery 22 §5), so **waiting for it means waiting a year.** If the gap matters now, the capture
change belongs in POS v1 — which is a decision for Ian, since v1 is live and this project does not
write to it (bible §2 rule 1).

## Open

1. **Is a paper logbook kept at the store today?** If so this is digitisation, and the paper record
   already satisfies the obligation while the software catches up.
2. **One discount only** — a PWD who is also a senior claims one 20%, not both. Does POS enforce
   that today, or is it left to the cashier?
