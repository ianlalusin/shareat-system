# T-509: planning docs follow the latest rulings (audit F35)

**Status:** SPEC 2026-11-03 (AUDIT, from Codex core-audit finding `decision-summaries-retain-superseded-rulings`, audit id F35).
Number T-509 given by BOSS on 3 Nov; Ian, 3 Nov: "work on them to close them". This is a docs-only change: no runtime
behaviour changes, no migration, no DEF row (Ian, 28 Oct: core-audit findings stay out of the register). One PR, branch
`audit/t509-decision-drift`.

## 1. The problem in plain words

Several planning documents still present an older ruling as current after Ian has replaced it. A reader (human or
agent) who opens the plan, and not the bible, acts on the old answer. The worst case: the remaining-build plan still says
"build backups, do not switch them on" (row 306), but row 354 (16 Oct) reverses that: switch on now, with one proven
restore drill, before the 15 Nov go/no-go.

## 2. Rule for every edit

- **Do not rewrite history.** Keep the old text, and mark it superseded right where it sits: a short bold note naming the
  bible row and date that replaced it, plus the current answer in one sentence. The exception is a line that is an
  INSTRUCTION ("do not switch on"): change the instruction to the current ruling, and keep the old one in brackets as history.
- Quote rulings from `PROJECT_BIBLE.md` §13 rows exactly as they stand there. Never invent a ruling, and never say whether
  backups are actually switched on today (the docs do not record that). State the ruling, not the status.
- Keep the bucket/retention choice (plan-q7 (a) vs the reviewed T-393 spec) marked OPEN: row 354 did not settle it.
- LF line endings only. No other files.

## 3. Edits

### 3.1 `docs/plans/remaining-build-plan.md` (backups: row 306 → row 354)
- Line 39 (Q7 row), line 52 (C5 row "Build and test; do not switch on"), line 86 (C5 table "not switched on until Ian
  sets it up"), line 130 (31 Oct checkpoint "if Ian has switched T-393 on"), line 242 (R7 "Backups not switched on
  (row 306)"): make each state row 354, "switch ON now with one proven restore drill, before the 15 Nov go/no-go
  (reverses row 306)", and keep the bucket/retention open point. R7 becomes the risk that the switch-on and the restore
  drill are not done before 13 Nov, not a certainty "until Ian acts".
- Grep the file for any other "row 306", "not switched on" or "do not switch on" and treat them the same way.

### 3.2 `docs/decisions/ADR-015-pos-and-customer-on-the-shared-backend.md`
- A3, line ~181, "Offline refunds: same tablet, same day, cash only, manager PIN": mark it superseded by row 356
  (17 Oct): NO refunds while offline in this phase ("Refunds need the internet."). Voiding an UNPAID table offline is
  allowed only for a signed-in manager or admin, marked `voidedOffline`, and reviewed after sync. Spec T-425.
- Also update any §5 / O6 sentence that still says offline refunds are allowed. Mark it, do not delete it.
- A5: read rows 341 and 342 (15 Oct) in the bible. If A5 still describes usage as check-only while also describing
  auto-post drafts, add one note naming rows 341/342 and their current pull-draft rule, quoted from the rows.
  If A5 already matches them, change nothing and say so in the hand-back.

### 3.3 `docs/decisions/OPEN-DECISIONS.md`
- §9 opening inventory (~line 122), the assets opening presentation (~line 184), §11 opening equity (~line 206): put an
  **ANSWERED** line under each heading naming bible row 109 (24 Aug) and its answer, quoted from the row: counted
  inventory; net-book-value assets with remaining lifespan; equity to 3300. Where a retained recommendation contradicts
  row 110 (FIFO) or row 111 (multi-company), add the same kind of note there.
- "Already decided" summary (~line 237), the Firebase Auth / Firestore directions: add a note. Row 280 (5 Oct) sets the
  target as a complete Firebase exit, phased. Rows 378/379 allow the interim Firebase release. Word it so it does NOT
  read as an immediate ban on current Firebase use.

### 3.4 `docs/tasks/398-s5/QUESTIONS.md`
- QI-1's opening "Today's answer (Q8 a, 10 Oct): per shipment ... nothing else": add **Superseded 25 Oct: QI-1 = (a)**
  (per-item received counts plus one "PG owes us" balance; row 388; see below).
- Two different questions are both called QI-2: the delivery fee (~line 22) and the bill verification (~line 111,
  answered A on 26 Oct, row 389). Do not renumber (other docs may cite them). Add a parenthetical to each heading saying
  which QI-2 it is, and that row 389 answers the bill-verification one only. Before editing, grep the repo for "QI-2" and
  list the citations in the hand-back.

### 3.5 `packages/db/src/cutover/classification.ts` (~lines 150-153)
- The `fiscal_periods` reason says "The only table in the schema that needs this class". Lobby tables later in the same
  file are `date_scoped` too. Reword it to be true (e.g. "Splits by date rather than by kind: 2026 pilot periods go,
  2027 stays."), dropping the "only table" claim. Change only the string; `dateColumn` / `keepFrom` stay untouched.
  Then grep for any test that asserts that string.

## 4. Checks
- `git diff --stat` shows only the five files above plus this spec.
- Root typecheck clean. Run the unit tests touching cutover classification (`npx vitest run --project unit` filtered to
  `classification` / `cutover` / `t342`), `tests/unit/*guard*`, `tests/unit/*census*`. If a docs lint or TOC test
  covers docs/plans or docs/decisions, run it.
- No CR bytes: `git diff | grep -c $'\r'` = 0.

## 5. Acceptance
Every location in §3 states the current ruling with its row number, the old text is still readable as history, nothing
claims a status the docs do not record, and the checks above are green. Closing F35 in `shareat-audits` happens after merge.
