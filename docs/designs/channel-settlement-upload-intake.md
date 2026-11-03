# Grab and Foodpanda settlement upload: EGM brainstorm intake (in progress)

Started 2026-11-02 with `/egm:egm_brainstorm`. Step 1 (clarification) is not finished; no Goldfish review has run.

## Facts found
- **v1** (`C:\Users\ianla\webapps\ERP-rebuild`, read-only):
  - The screen is `src/app/manager/channel-settlements/page.tsx`. The batch logic is `src/lib/actions/channel-settlement-batch.actions.ts` (approve or hold).
  - The parsers are `src/lib/financial/channel-settlement/parse-{grab,foodpanda}.ts` (with drift and real-loan-data tests) and `src/lib/actions/extract-pdf-text.actions.ts`. About 5,500 lines in all.
  - It compares the file's gross sales per day ("fileGross") against what staff recorded as the platform receivable ("AR recorded"), and shows the difference per day.
  - It uses `xlsx` 0.18.5, which has known vulnerabilities. Do not carry it over.
- **v2** (shareat-system):
  - Manual settlement entry only: `apps/erp/src/app/channel-settlements/` (T-150).
  - The receivable sits on account 1220. Fees post to 6400 and up.
  - Batch upload and parsers were left out of scope in T-150 §Out of scope.
  - Related: T-174 (discrepancy settle and defer), T-350 (payout account), T-507 (platform receivables on the AR report).

## Ian's answers (2026-11-02)
- **Users:** the manager and the admin only. Ian does it himself today.
- **Why it matters:** about 20% of sales come through Foodpanda and Grab.
- **Pain today:** reading each part of the report, understanding what each line means, and booking it.
- **Files:**
  - Foodpanda sends a **zip** with **xls and pdf** inside.
  - Grab sends **xls and csv**.
- **What done looks like ("same as v1"):**
  - All sales from the invoice compared against the figure entered by hand, with a summary of the differences.
  - An **Accept** or **Hold** button for each discrepancy.
  - A **separate table for loan payments** the platform deducted.
  - A **separate table for charges** (commission, marketing, and so on).
  - Everything ready to review, verify and record.

## Round 2 answers (2026-11-02)
1. **Payout rhythm:** Foodpanda pays **weekly**. Grab pays **daily**. (Store count per platform not given yet.)
2. **Loans:** the merchant loan is on **Grab** only. (Not said whether it is already recorded or first seen in the payout file.)
3. **What happens to a held day:** Ian: "not clear". Needs a plainer question.
4. **Bad or changed files:** none seen before. Ian wants **AI help** for reading the files, using the AI the ERP already has.
   - v1 has it: `genkit` with Anthropic, Google and OpenAI-compatible plugins (`ERP-rebuild/package.json:35-76`).
   - v2 has **no** AI package yet (checked root and `apps/erp` package.json files). Adding one is a new decision.

## Implication to test later
Grab daily means ~30 payout files a month per store, so the upload must be quick and must not make a person redo each day by hand. Foodpanda weekly means one zip per week.

## Round 3 answers (2026-11-02)
- **AI rule:** the AI only reads, summarizes and presents. It never posts anything.
- **AI role (option B):** a plain parser reads normal files. The AI steps in only when a file looks strange or changed.
- **Held / discrepancy:**
  - The admin or manager confirms what happened and why the gap is big.
  - **The platform's settlement file always wins.** The manual figure is overruled 100% of the time.
  - Ian mainly wants to **see** what happened.
- **Loan:** already recorded in the system (so the payout file's loan line is matched to a known loan, not created from the file).
- **Stores:** Lipa, Malvar, Davao, Banay-banay (closing), PG (will enroll). Which store sells on which platform is not yet given.

## Open risks to carry into the review
- "File always wins" means Accept and Hold may be the same action in practice. Hold may only be "look first, apply later". The review should test this.
- A missing or partial file looks like a shortfall. The tool must tell "platform paid less" apart from "file is incomplete".
- Store list changes (one closing, one joining), so stores must come from data, not code.
- Grab daily across several stores is many files a month. Upload should take many files at once.
- No AI package in v2 yet. First use of AI here needs its own decision (provider, cost, where the key lives).

## Round 4 answer (2026-11-02): how a file finds its store
- Each store's **Foodpanda and Grab store code** is set in **store settings, under sales channel**. The app uses that code to decide which store an uploaded file belongs to.
- This also answers "which store sells on which platform": a store has the platform if it has a channel with a code.
- Checked in v2: `sales_channels` (`packages/db/schema/sales-days.ts:70`) is already one row per store, with `name`, `is_remitted_daily` and `receivable_account_code`. It has **no column for the platform's own store code**. Adding one is a schema change (hand-authored migration, ADR-012).
- Not yet checked: where the code appears inside each file (Grab xls/csv, Foodpanda xls and pdf) and whether it is the same string the platform uses everywhere.

## Open risks added
- A file whose code matches no store, or two stores, must be refused with a clear message, not guessed.
- When PG enrolls, someone must enter its codes before its first upload. The upload screen should say so.

## Still to ask
- None blocking. Remaining unknowns go to the Goldfish review.

## Next
Finish Step 1 → readiness gate → Goldfish review (`egm:egm-synthesizer`, BRAINSTORM mode) → write `concepts_brief.md`.
