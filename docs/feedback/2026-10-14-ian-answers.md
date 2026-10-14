# Ian's answers to the 14 questions — 2026-10-14

Answers to "Questions for Ian" in [`2026-10-14-ian-feedback-review.md`](./2026-10-14-ian-feedback-review.md).
Ian's words in quotes; the orchestrator's one-line reading after each. **The Opus planner turns these into bible §13 rows**
(several reverse or narrow recorded decisions and must not be built before that row exists).

| # | Topic | Ian's answer | Reading |
|---|---|---|---|
| 1 | Till | "a" | **Mirror, not move.** ERP keeps till custody; the POS v2 screen drives the same ERP till/shift records. ADR-015 amendment + P1/P2 task. |
| 2 | Settlements | "a - it must accept zip xls and pdf files that it will parse and post" | No write to v1 (dual-run comparison only). **New:** Grab/Foodpanda settlement-file parsers accepting **zip, xls and pdf**, parsing to a settlement that is then posted through the existing settlement action. Explicit store selection, not filename routing. |
| 3 | Cashier methods | "the cashier must see all payment method with filter based on balance if already enforced then let it be" | Cashier sees **all** payment methods; a method is filtered/refused by **available balance**. Verify the balance rule (row 154 overdraft) is enforced on the expense screen; if it is, no change. |
| 4 | Credentials | "1 account. coz now v1 has 2 accounts the accountid in local user is different from the log in id, i want them to be just 1 account but still no pin for log in in clock but pin can be used in signing in to use the app" | **One identity per person** (v1 had two ids: the local user id ≠ the sign-in id). The clock stays **fingerprint/card only, no PIN** (row 165 stands); the **app** sign-in may use the PIN. Check v2 already has one `persons` id behind both; fix any second id. |
| 5 | Pick a role | "a" | **Narrowing-only role pick** at sign-in for staff with ≥2 positions at that store; hand grants kept; switching mid-shift needs the PIN. Supersedes part of row 198. |
| 6 | Needs receipt | "a" | **True exemption:** a per-category flag "no receipt needed" — such expenses need no evidence at all. Reverses T-196 decision 2 (`needReceipts` not ported). The planner must say how orphan expenses stay visible (e.g. the category list is admin-only and audited). |
| 7 | Expense items | "yes" | **Approve** a separate expense-item master (item → fixed category), with a manager request queue for new items; no free text. |
| 8 | Convert | "a" | Keep **convert** as the unpaid same-slab re-cut; add **paid/unpaid (who, piece rate)** to slicing. |
| 9 | Liabilities | "when template is created add the recurring timing then build up based on the selected period. liabilities are mixture of recurring expense unpaid, invoices unpaid etc." | A recurring template carries its **timing** and **accrues per selected period**. "Liabilities" is one view of everything unpaid: unpaid recurring expenses, unpaid supplier invoices, etc. |
| 10 | Price list | "a" | **Store the rule, freeze the rate** on each order line. |
| 11 | Destructive buttons | "a" | **Two tiers:** retype the name (retire/deactivate); **admin PIN, verified on the server** (void posted, delete, cutover, separation). |
| 12 | AI / OCR | "i lean on ocr first can, if we can employ local lightweight engine to make ocr engine more reliable we do that. local first consideration" | **OCR first, local first.** A lightweight engine running on our own server is allowed (narrows row 251, which barred sending receipts to AI). OCR proposes, a person disposes. Research the engine before building. |
| 13 | Customer screen | "yes" | The ERP customer screen also shows the diner's **loyalty profile** (new person↔customer link; ADR-015 P3). |
| 14 | Wastage pull | "no i just mention it since its not existing then its ok" | Nothing to retire; closed. |
