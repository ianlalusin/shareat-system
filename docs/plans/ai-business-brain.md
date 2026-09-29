# The AI business brain — plan stub (Ian, 2026-09-29)

**Status:** REQUESTED 2026-09-29 — **not yet assessed, not specced, nothing built.** Next step is the assessment
pass (bible §13 row 163: *assess → research → plan*, via `/research-evaluate-propose`), then a phased plan here.
Task number reserved for the assessment: **T-359**.

## Ian's request, verbatim
> "add to plan onboard an ai that watches the expenses daily check if the records are correct, spot anomalous
> expenses, flag expenses that are not for business basically an ai brain for business activity first part only is
> the expense later we will add other parts of it"

## What it is (as stated)
An AI reviewer over business activity. **Phase 1 = expenses only**; later phases add other activity (sales days,
remittances, inventory, payroll…) — Ian will name them.

Phase 1, three jobs, run **daily**:
1. **Correctness** — are the expense records right (amounts, splits, categories, links to supplier invoices, the
   money lines, the ledger postings they produced)?
2. **Anomalies** — spot expenses that are unusual (amount, frequency, supplier, store, time, category drift…).
3. **Not-for-business** — flag expenses that look personal / non-business.

## Questions the assessment must answer (not decisions — inputs)
- **Utilisation vs effort** in numbers: live expense volume per day/store (count it — §1.2d), who reads the flags,
  what they do with one.
- **Where it sits in the architecture:** Postgres is the truth (bible §2.3); the AI must READ, never write
  authoritative state. Flags are advisory records with a human disposition (reviewed / dismissed / escalated) —
  an audit-logged queue, not an auto-void. Which rules are deterministic (a SQL check is cheaper and exact) vs
  genuinely need a model (free-text "is this for business?").
- **Model & cost:** Claude API (default to the current Claude models), batch once a day; data sent off-box —
  what fields, redaction of staff PII, per-org isolation (one org today; DEF-491 before a second).
- **Existing prior art:** v1 (ERP-rebuild) — does anything already review expenses? Industry pattern (expense-audit
  tools, rule + ML hybrids). GitHub.
- **Trust:** false-positive budget; every flag cites the record and the reason; nothing blocks a posting.
- **Dependencies:** DEF-492 (the COD rule lives only in the web action) and DEF-485 (fixed) are the kind of
  correctness gaps a deterministic layer should catch first.

## Later phases (placeholders — Ian to define)
- Phase 2+: other business activity. Not scoped.
