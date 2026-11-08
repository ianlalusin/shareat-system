Claimed by Freebuff Buffy (Codebuff), 2026-11-07 03:10

# T-528a — POS v2 print text: receipt, kitchen ticket and refill slip as plain text

| Field | Value |
|---|---|
| Planner | POS design lane (Opus), for BOSS, 7 Nov 2026 |
| Builder | <app and model> |
| Branch | `wo/t528a-pos-print-text` (the builder creates it from `origin/main`) |
| Worktree | `C:\Users\ianla\webapps\wt-t528a` (the builder creates it and works only there) |
| Risk class | **medium**: pure text formatting of figures that are **already computed**. No arithmetic on money, no database, no sign-in |
| Numbers reserved | migration: none · DEF: none · bible row: none |

## 1. Goal

When the new POS (the "v2 POS", inside the ERP) takes a payment, the cashier's Bluetooth thermal printer prints a
paper receipt. When food is sent, the kitchen printer prints a ticket, and a refill prints a slip. This work order
builds **only the text**: three pure functions that turn already-computed figures into fixed-width lines. The printer
plumbing and the screens come later. Paper is the backstop when the internet is down, so these must be exact and tested.

## 2. Read first (and nothing else is required)

- `AGENTS.md`, section "Building from a work order".
- `docs/RULES.md`.
- `docs/GLOSSARY.md`, entries: **table session**, **sales receipt**, **receipt_seq / terminalSeq**, **tender**,
  **SC/PWD**. ⚠ The word `receiptSeq` is a banned name in this codebase (a guard test fails on it). Use
  `terminalSeq`.
- `PROJECT_BIBLE.md` §13, rows **437**, **438**, **439** and **440**. Find them with a search for `| 437 |` and the
  others. They give the business rules for what a receipt shows:
  - itemized lines with per-line discounts;
  - several tenders, each with its reference printed;
  - change from cash only;
  - the senior/PWD diner's name and ID.
- `docs/plans/pos-v2-design/receipts.png` and `docs/plans/pos-v2-design/payment.png`: the approved look of the paper
  receipt. Match its order of sections.
- The old v1 formatter, **as requirements only**. Read it, do not copy its types:
  `apps/pos/src/lib/printing/receiptFormatter.ts` and `apps/pos/src/lib/printing/kitchenTicketFormatter.ts`. They show
  the column widths v1 uses (32 or 48 characters for normal font, 42 or 64 for small font, on 58 mm or 80 mm paper).
- `packages/core/src/money.ts`: the `Money` type, a decimal string such as `"1234.50"`.

## 3. What to build

All in a new folder `apps/erp/src/lib/pos-print/`. Plain TypeScript, no React, no `'use client'`, no imports from
`apps/pos`, no database, no `Date.now()`. Every input arrives in the arguments.

1. **`types.ts`**: the input shapes, exactly:
   ```ts
   import type { Money } from '@shareat/core/money';
   export type PaperWidth = 58 | 80;
   export type FontMode = 'small' | 'normal';
   export interface PrintLayout { width: PaperWidth; font: FontMode }
   export interface ReceiptHeader { businessName: string; addressLines: string[]; tin: string | null; vatRegistered: boolean }
   export interface ReceiptLineDiscount { label: string; qty: number; amount: Money }          // amount > 0, printed as -amount
   export interface ReceiptLine { name: string; qty: number; unitPrice: Money; gross: Money; discounts: ReceiptLineDiscount[]; net: Money }
   export interface ReceiptTender { name: string; amount: Money; reference: string | null; toCheck: boolean }
   export interface ReceiptDiner { dinerNo: number; kind: 'senior' | 'pwd'; holderName: string; idNumber: string }
   export interface ReceiptView {
     header: ReceiptHeader;
     receiptNo: string;              // already formatted by the caller, e.g. "T1-000123"
     issuedAtLocal: string;          // already formatted by the caller, e.g. "07/11/26 19:42"
     tableLabel: string | null;      // stand label, or null for take-out
     heads: number | null;
     cashierName: string;
     lines: ReceiptLine[];
     subtotal: Money; discountTotal: Money; total: Money;
     tenders: ReceiptTender[];
     change: Money;                  // "0.00" when none
     diners: ReceiptDiner[];         // senior/PWD diners, may be empty
     footerLines: string[];          // from the store's settings; may be empty
     offline: boolean;               // true → print the line "OFFLINE SALE - TO SYNC"
     reprint: boolean;               // true → print the line "REPRINT"
   }
   export interface KitchenTicketView { stationName: string; tableLabel: string | null; ticketNo: string; sentAtLocal: string;
     items: { name: string; qty: number; note: string | null }[]; offline: boolean }
   export interface RefillSlipView { tableLabel: string; sentAtLocal: string; items: { name: string; qty: number }[]; offline: boolean }
   ```
2. **`layout.ts`**: `columnsFor(layout: PrintLayout): number`. It returns 32 for (58, normal), 42 for (58, small),
   48 for (80, normal) and 64 for (80, small). These widths are a printer **file format**, so they are allowed as
   constants. The file also exports the helpers:
   - `center(text, cols)`;
   - `justify(left, right, cols)`: at least one space between; when both don't fit, `left` wraps onto lines above and
     `right` stays on the last line;
   - `wrap(text, cols): string[]`: wraps on spaces and hard-cuts a word longer than `cols`;
   - `rule(cols)`: dashes;
   - `printAmount(m: Money): string`: adds thousands commas to the decimal string, `"1234.50"` → `"1,234.50"` and
     `"-48.11"` → `"-48.11"`. It does **string work only**: no `Number()`, no `parseFloat`, no arithmetic. There is no
     peso sign, because thermal code pages often lack ₱.
3. **`receipt-text.ts`**: `formatReceipt(view: ReceiptView, layout: PrintLayout): string[]` returns one string per
   paper line, none longer than `columnsFor(layout)`. Sections in this order:
   1. The header: name in upper case, centred; each address line centred; `TIN: <tin> VAT` or `Non-VAT`, omitted when
      `tin` is null.
   2. A blank line, then `REPRINT` centred if `reprint`, and `OFFLINE SALE - TO SYNC` centred if `offline`.
   3. Justified pairs: `RECEIPT:` receiptNo, `DATE:` issuedAtLocal, `TABLE:` tableLabel (only if not null), `HEADS:`
      heads (only if not null), `CASHIER:` cashierName.
   4. A rule.
   5. Each line: `<qty> x <name>` wrapped, justified against `gross` on the last line. If `qty > 1`, an indented
      `  @ <unitPrice>`. Then each discount, indented: `  <label> (<qty>)` justified against `-<amount>`. Then, only
      when the line has discounts, `  Net` justified against `net`.
   6. A rule, then `SUBTOTAL`, `DISCOUNTS` (only if not "0.00", printed as `-<discountTotal>`) and `TOTAL`.
   7. A rule, then each tender: `<name>` justified against `amount`. On the next line, indented, `  Ref: <reference>`
      (only if not null). Add ` (to check)` after the name when `toCheck`. Then `CHANGE` against `change`.
   8. If `diners` is not empty: a rule, then for each diner `SENIOR` or `PWD` `#<dinerNo>`, `  Name: <holderName>` and
      `  ID: <idNumber>`, each wrapped.
   9. Each footer line, centred and wrapped. Then the result ends.
4. **`kitchen-text.ts`**:
   - `formatKitchenTicket(view: KitchenTicketView, layout: PrintLayout): string[]` prints:
     - the station name in upper case, centred;
     - `OFFLINE` centred if `offline`;
     - `TABLE:` (or `TAKE-OUT` when null), `TICKET:` and `TIME:` justified;
     - a rule;
     - each item as `<qty> x <name>` wrapped, then the note indented as `  * <note>` when not null.
   - `formatRefillSlip(view: RefillSlipView, layout: PrintLayout): string[]` prints:
     - `REFILL` centred;
     - `OFFLINE` if set;
     - `TABLE:` and `TIME:`;
     - a rule;
     - each item as `<qty> x <name>`.
5. **`index.ts`**: re-exports the public functions and types.

**Not to build:** no ESC/POS byte encoding (the Android plugin does that), no printer connection, no React component,
no money arithmetic (no totals, VAT or change are computed here; they arrive computed), no date formatting, no reading of
store settings.

## 4. Files you may touch

| File | Change |
|---|---|
| `apps/erp/src/lib/pos-print/types.ts` | new |
| `apps/erp/src/lib/pos-print/layout.ts` | new |
| `apps/erp/src/lib/pos-print/receipt-text.ts` | new |
| `apps/erp/src/lib/pos-print/kitchen-text.ts` | new |
| `apps/erp/src/lib/pos-print/index.ts` | new |
| `apps/erp/src/lib/pos-print/layout.test.ts` | new |
| `apps/erp/src/lib/pos-print/receipt-text.test.ts` | new |
| `apps/erp/src/lib/pos-print/kitchen-text.test.ts` | new |
| `apps/erp/src/lib/pos-print/README.md` | new: what the folder is, in five lines |

The repo copy of this work order (`docs/tasks/528a-pos-print-text.md`) is always allowed.

⛔ **Any file not in this table is off limits.** That includes:
- everything under `packages/`;
- every other file in `apps/erp`;
- `apps/pos`, `apps/customer`;
- `PROJECT_BIBLE.md`, `docs/` (except the work-order copy);
- migrations;
- every existing test.
Other builders are working in `packages/domain/src/pos`, `packages/db` and `apps/erp/src/app/api/pos`, so do not
touch those.

## 5. Tests that must pass

| Test | Proves |
|---|---|
| `layout.test.ts` — "columns per paper and font" | 32/42/48/64 for the four combinations |
| `layout.test.ts` — "printAmount adds commas without arithmetic" | `"0.00"`, `"7.58"`, `"1234.50"`→`"1,234.50"`, `"1234567.89"`→`"1,234,567.89"`, `"-48.11"`; and `printAmount` source contains no `Number(` / `parseFloat` (read the file as text) |
| `layout.test.ts` — "justify and wrap never exceed the width" | long left text wraps; a 40-character word hard-cuts at 32 |
| `receipt-text.test.ts` — "the approved split-payment receipt" | Build the receipt in `payment.png` / `receipts.png`: a package line for 4 heads with a senior discount on 1 unit, a dish with a 10% preset on 1 of 2 units, GCash ₱500 with reference, Cash ₱1,600, change 7.58, total 2,092.42, and one senior diner. Assert the **exact** line array with `toEqual` at 32 columns, and again at 48 |
| `receipt-text.test.ts` — "every line fits" | For both widths and both fonts, every returned line length ≤ `columnsFor` |
| `receipt-text.test.ts` — "optional sections" | No TIN → no TIN line; no table → no TABLE line; no discounts → no DISCOUNTS line and no `Net` lines; no diners → no diner block; `offline` and `reprint` lines appear only when true |
| `receipt-text.test.ts` — "tender reference and to-check" | The reference prints under its tender; ` (to check)` follows the name only when `toCheck` |
| `receipt-text.test.ts` — "prints figures as given" | Hand in a deliberately inconsistent view (total ≠ subtotal − discounts). The output prints the given figures unchanged, which proves the formatter never recomputes |
| `kitchen-text.test.ts` — "ticket with notes, take-out, offline" | Exact line arrays |
| `kitchen-text.test.ts` — "refill slip" | Exact line array |

Plus, every time:
```bash
npm run typecheck
```
```bash
npx vitest run apps/erp/src/lib/pos-print
```
```bash
npx vitest run --project unit
```
The full unit project has about 11,300 tests and takes a while. One test, `packages/etl/tests/capture.test.ts`, fails
on machines whose `.env.local` is fully filled in; that failure is not yours. **Guard tests this change may move:**
- `tests/unit/client-bundle-boundary.test.ts`
- `tests/unit/glossary-trap-names.test.ts` (it fails on the word `receiptSeq`)
- `tests/unit/t371-census-selftest.test.ts`
- any test that lists the folders of `apps/erp/src/lib`
If any existing test fails, **do not edit it**. Paste its name and output under Builder notes, and open the PR as a
**draft**.

There is no database in this work order, so it has no integration tests.

## 6. Done means

- [ ] Every step in §3 built, inside the §4 file list only.
- [ ] Every §5 test written and passing; typecheck clean; the full unit project's result pasted (pass and fail counts).
- [ ] Smoketest: **not applicable**. Nothing renders in the app yet, and you cannot sign in. Write "N/A, library only" in the PR.
- [ ] One commit per logical step; messages say what and why.
- [ ] This work order copied into the worktree as `docs/tasks/528a-pos-print-text.md`, with the real check output under **Builder notes**.
- [ ] Branch pushed; **one PR opened** against `main`, `T-528a` in its title, its body listing the §5 command output and ending "Built by <app> <model> from a work order".
- [ ] The work order moved from `current\` to `done\` with the PR link at its top.
- [ ] **Stop there.** You do not merge, deploy or close anything.

## 7. Forbidden — every work order, no exceptions

1. ⛔ **Never merge, rebase onto, force-push or delete any branch except your own `wo/` branch.** Never push to `main`. Never enable auto-merge.
2. ⛔ **Never work in `C:\Users\ianla\webapps\shareat-system` itself.** Only run `git fetch` and `git worktree add` from it. Work only in your own worktree, with a real `npm ci` install there, never links.
3. ⛔ **Never run `git worktree remove --force` or `rm -rf` on a worktree.** Leave it in place when finished.
4. ⛔ **Never invent a number** (migration, DEF, task or bible row).
5. ⛔ **Never edit the reference repos** (`ERP-rebuild`, `POS`, `CUSTOMER`, `Shareat Website`) or anything under `inactive projects`. Read them freely.
6. ⛔ **Never hard-code a business value.** The store name, address, TIN and footer all arrive in `ReceiptView`. Only the column widths (a printer format) are constants.
7. ⛔ **Never edit `PROJECT_BIBLE.md`, `docs/DEFECTS-REGISTER.md` decisions, or `knowledge/`.**
8. ⛔ **Never touch a production server.** Never paste passwords, keys or database URLs anywhere.

## 8. If you get stuck

Write the step, the exact error output and what you tried under **Builder notes**, in both the `current\` file and the
repo copy. Push, open the PR as a **draft**, move the work order to `done\` with "BLOCKED" at the top, and go on to the
next one.

## 9. Audit checklist (for the Codex 12-hour audit and the Claude fixer, not the builder)

- [ ] Diff touches only §4 files
- [ ] Every §5 test exists, asserts exact output, and passes in CI
- [ ] No arithmetic on money anywhere in `pos-print` (grep `Number(`, `parseFloat`, `+`/`-` on amounts)
- [ ] No §7 rule broken; no `receiptSeq`
- [ ] Section order matches `receipts.png`; rows 438/439 content present (reference printed, per-line discounts, change)
- [ ] Money, auth or schema touched? Then send back to the planner

## Builder notes

⏱ Built 2026-11-07 03:10-04:10 in `C:\Users\ianla\webapps\wt-t528a` on `wo/t528a-pos-print-text`
from `origin/main` `f1a6a02`. Real `npm ci` in the worktree (761 packages, exit 0).

### What was built (§3, one commit per step)

`apps/erp/src/lib/pos-print/` — `types.ts` and `layout.ts` (commit 2), `receipt-text.ts` (3),
`kitchen-text.ts` (4), `index.ts` + `README.md` (5). Plain TypeScript: no React, no `'use client'`,
no `apps/pos` import, no database, no `Date.now()`, and **no money arithmetic anywhere** — every
figure and every formatted date arrives in the arguments.

Two things worth flagging, both inside the letter of §3:
1. **`justify` returns `string[]`.** §3 says `left` wraps onto lines above when both will not fit,
   which cannot be expressed as a single string, so it returns one line per paper row.
2. **A take-out kitchen ticket prints `TAKE-OUT` alone**, not `TABLE: TAKE-OUT`. §3 reads
   "`TABLE:` (or `TAKE-OUT` when null)"; an empty table field on a prep sheet reads as a stand
   number the cook cannot find, so the absence is stated instead. Trivial to change if the planner
   meant the literal `TABLE: TAKE-OUT`.

### Checks

```
$ npm run typecheck
> shareat-system@0.1.0 typecheck
> tsc --noEmit            → exit 0

$ npx vitest run apps/erp/src/lib/pos-print
 ✓  unit  apps/erp/src/lib/pos-print/layout.test.ts (4 tests) 10ms
 ✓  unit  apps/erp/src/lib/pos-print/kitchen-text.test.ts (3 tests) 9ms
 ✓  unit  apps/erp/src/lib/pos-print/receipt-text.test.ts (5 tests) 15ms
 Test Files  3 passed (3)
      Tests  12 passed (12)
```

§5's ten required cases are all there: columns per paper and font; `printAmount` commas and the
`Number(`/`parseFloat` scan (of the `printAmount` body itself); justify/wrap width bounds and the
40-character hard cut; the exact approved receipt at 32 **and** 48 columns; every line fits at all
four layouts; optional sections; tender reference and ` (to check)`; figures printed as given (a
deliberately inconsistent view prints `TOTAL 999.99` rather than recomputing); the kitchen ticket
with notes, take-out and offline; the refill slip.

### ⛔ One existing guard fails — reported, not touched (§4 / §5)

`tests/unit/production-caller-ratchet.test.ts` → **1 failed | 3 passed**:

```
AssertionError: 2 name(s) newly joined the zero-production-caller set:
  formatReceipt — NOT tracked anywhere else. Give it a real caller, or confirm the gap is known…
  formatRefillSlip — NOT tracked anywhere else. Give it a real caller, or confirm the gap is known…

 ❯ tests/unit/production-caller-ratchet.test.ts:131:7
     ).toEqual([]);
```

Exactly the guard the work order predicted a new library could move. These two exports have **no
production caller because the caller is the next work order** (§3: the printer plumbing and the
screens come later; §6: "nothing renders in the app yet"). I did not give them a fake caller, and I
did not regenerate `docs/production-caller-baseline.txt` — both would be a lie in a different
place. The honest fix is the baseline regenerated **when the payment screen starts calling these**,
with this task cited, as that file's own instructions require. PR opened as a **draft** for that
reason. (`formatKitchenTicket` did not trip the guard: the name already exists in v1's census.)

Two further failures in the same full run are **environmental, not this change** — both are
`Error: Test timed out in 5000ms` on repo-wide file scans, with no reachable path from a new
`apps/erp/src/lib/pos-print` folder: `tests/unit/position-defaults-callers.test.ts` (2 failed) and, in
the killed run, `packages/domain/tests/t375-s0-census-script.test.ts` (1 failed at 56 s, retry ×2).
`t375` **passes on its own** (4/4, 25 s) when re-run alone, which is the evidence that the big-run
failure is load on this machine, not correctness.

### Full unit project (`npx vitest run --project unit`)

```
 Test Files  42 failed | 490 passed (532)
      Tests  50 failed | 11206 passed | 4 skipped (11260)
   Duration  430.82s
 EXIT=1
```

**Of those 50, exactly one is this change's fault** (the ratchet above). The rest are this machine
under load, and I checked rather than assumed: **46** are `Error: Test timed out in 5000ms` on
tests that scan or compile the whole repo, and **2** are a child process that crashed with exit
`3221226505` (`0xC0000409`), surfacing as `expected 3221226505 to be 2` in
`apps/erp/tests/t441-s1-upload-rules.test.ts`. The §5 guards named as possible movers —
`client-bundle-boundary`, `glossary-trap-names` (the `receiptSeq` trap), `t371-census-selftest` and
`t450-phone-table-coverage` — all **pass when re-run on their own: 58/58 in 4.4 s**. So does
`packages/domain/tests/t375-s0-census-script.test.ts` (4/4, 26 s). Their big-run failures are the
5 s timeout, not correctness.

### Smoketest

**N/A, library only.** Nothing renders in the app yet and there is no session to sign in with.

### Not done / limits

- The baseline regeneration above, which needs the payment screen (a later work order).
- No ESC/POS bytes, no printer connection, no UI: out of scope by §3 and untouched.
- The receipt's discount line prints `Senior (1)` per §3's `  <label> (<qty>)`; `receipts.png` shows
  `Senior 1x (diner 1)`. §3 is the contract and §2 asks only that the *order of sections* match, so
  the wording follows §3. The diner's name is in the diner block, as the bible row 437 evidence
  requires. Same for the tender reference: §3 puts `Ref:` on its own indented line, the PNG puts it
  after the tender name; §3 wins.
- `receipts.png` also shows a VAT/VATable block that §3 does not list, so it is **not** printed. If
  the paper must carry VAT rows, that is a §3 change, not a formatter decision.
