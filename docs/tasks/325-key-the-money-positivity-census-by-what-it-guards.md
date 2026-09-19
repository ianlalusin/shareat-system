# T-325 — the money-positivity census is keyed by the comparison it guards, not by the line that comparison sits on

**Status:** SPEC — drafted by the orchestrator (`system32-4f`), 2026-09-19. **Revision 2**, rewritten
whole after the auditor's spec review. Not yet approved.
**Closes:** DEF-376.
**Migration slot:** none. This task adds no schema change.

> ⛔ **ANCHOR TABLE — GREP THESE, NEVER A LINE NUMBER.** A line number is a claim with a shelf life
> measured in commits (bible row 204; eight stale-number incidents on 2026-09-18/19, twice inside a
> correction to an earlier stale number).
>
> ⛔⛔ **AND FIVE OF THESE ANCHORS NEED A REF, BECAUSE THIS TASK DELETES THE CODE THEY POINT AT.**
> An anchor is durable against edits *elsewhere* in a file — that is what it is for, and why it beats
> a line number. **It is NOT durable against the edit that removes the anchored code**, and a task
> whose job is to MOVE code does exactly that. The tester correctly deleted the scanner internals
> from the guard test; the builder is told to copy them. Two lanes working in opposite directions on
> one file. **Verified 2026-09-19: all five resolve at `d4bac7d` and NONE resolves in the worktree.**
>
> | Anchor (grep for this) | Look in |
> |---|---|
> | `const NUMBER_CMP = ` | ⛔ **`git show d4bac7d:packages/domain/src/shared/money-positivity-guard.test.ts`** |
> | `const NEG_PAREN_GT = ` | ⛔ same **pinned ref** |
> | `function stripComments(` | ⛔ same **pinned ref** |
> | `function scan(` | ⛔ same **pinned ref** |
> | `const CLASSIFIED: Record<string, string> = {` | ⛔ same **pinned ref** |
> | `positive control — a known, deliberately-unrouted rate check is still found` | worktree guard test (test name) |
> | `CLASSIFIED names no site the scanner no longer finds` | worktree guard test (test name) |
> | `if (Number(input.rate) < 0) {` | `packages/domain/src/customers/index.ts` — the positive control's target |
> | `already settled by an earlier batch` | `packages/domain/src/remittance/allocate.ts` |
> | `"@shareat/domain/*"` | `tsconfig.json` — the wildcard the CLI's import relies on |
>
> ⛔ **The builder copies `stripComments`, `NUMBER_CMP` and `NEG_PAREN_GT` from the PINNED REF, byte
> for byte, and reconstructs nothing.** The failure this guards against is not stopping — it is
> rebuilding a regex from this spec's prose, getting one character wrong, and silently changing which
> sites the census finds. ⭐ **The auditor holds the same pinned file and DIFFS the copies rather
> than eyeballing them.**
>
> ⭐ **The rule, generalised:** in an extract/move task, every anchor pointing into the code being
> moved carries a ref; anchors into untouched files or into the destination stay bare. Five of the
> ten above needed it and five correctly did not.

## ⚠️ Revision 2 — what changed and why, so nobody works from revision 1

Revision 1 said "key by the trimmed source **line**." The auditor showed that had drifted from
DEF-376's own remedy, which asks for *"the trimmed source text of the **comparison** … breaks only
when the comparison ITSELF changes."* **24 of the 49 guarded lines carry payload beyond the
comparison** — error-message strings, template literals, a trailing comment — so line-keying left
them breakable by an error-message reword. That is DEF-376 narrowed from "any edit above the line"
to "any edit to the line", not cured.

**Revision 2 keys on the comparison.** The intermediate fix from revision 1 (strip comments before
keying) is **subsumed and no longer stated separately** — a comment cannot reach a comparison-only
key at all.

⭐ **And one thing the measurement found that neither the spec nor the audit predicted:** keying on
the comparison *as the matching regexes see it* silently truncates a real numeric literal. Three
sites compare against a **0.005 tolerance**, and the matching regex stops at the `0`:

| site | what bare-comparison keying would key on | what it actually says |
|---|---|---|
| `cash-requests/index.ts` | `Number(after.outstanding) <= 0` | `Number(after.outstanding) <= 0.005` |
| `liabilities/index.ts` (×2) | `Number(after.outstanding) <= 0` / `Number(outstanding) > 0` | `… <= 0.005` / `… > 0.005` |

⛔ **Changing a tolerance from `0.005` to `0` is a real change to a money comparison, and that key
would not notice it.** Revision 2 therefore keys on the comparison **including its full numeric
literal**, which was measured to cost nothing: **46 keys and 3 collisions either way.**

## The measurements this spec is built on — 2026-09-19, reproduce them before doubting them

Every figure below was taken by re-running the guard's own `stripComments` and its two regexes over
`packages/domain/src`. Both lanes and the auditor independently re-derived the first block and all
three agreed.

| Figure | Value |
|---|---|
| Matches the scanner finds | **49** |
| `CLASSIFIED` entries today | **49** (1:1 with the found set; 0 stale, 0 unexplained) |
| Guard test today | **green, 4 tests** |

**The keying options, all measured, not argued:**

| Key built from | Distinct keys | Collisions | Breaks on an error-message or comment edit |
|---|---|---|---|
| whole source line (revision 1) | 48 | 1 | **24 of 49** |
| comment-stripped line (revision 1 + amendment 1) | 48 | 1 | **23 of 49** |
| comparison only, bare `0` | 46 | 3 | immune — **but truncates 3 tolerances** |
| ⭐ **comparison + full numeric literal (ADOPTED)** | **46** | **3** | **immune, and keeps the tolerances** |

**The 3 collisions under the adopted key**, each two sites inside one file:

| Key | Sites | Enclosing functions |
|---|---|---|
| `loans/index.ts::Number(amount) <= 0` | 2 | `disburseLoan`, `recordLoanPayment` |
| `prepaid/index.ts::Number(refunded) > 0` | 2 | both in `writeOffPrepaidItem` |
| `recurring-expenses/index.ts::Number(defaultAmount) <= 0` | 2 | `createRecurringTemplate`, `updateRecurringTemplate` |

⚠️ **The collision count is a property of the key, not a fact about the codebase.** Revision 1's
"only 1 collision" looked better only because the key carried the error-message payload that made it
fragile. The two properties trade directly against each other, and §4 below removes the downside
rather than merely naming it.

## Scope — the exact files, and they are disjoint by role

**BUILDER — source only. You may not open a `.test.ts` file for any reason.**
- `packages/domain/src/shared/money-positivity-census.ts` — **new.** The scanner, extracted.
- `scripts/money-positivity-census.ts` — **new.** The CLI that gives the module a real caller.

**TESTER — tests only. You may not open either file above.**
- `packages/domain/src/shared/money-positivity-census.test.ts` — **new.** Unit tests for the module.
- `packages/domain/src/shared/money-positivity-guard.test.ts` — **existing.** Re-keyed, plus the
  behaviours DEF-376 is about.

⛔ **Neither lane touches any other file under `packages/domain/src`.** This task changes **no**
guarded comparison. If a site's text looks wrong, that is a QUESTION, never an edit.

## Contract

### 1. The census logic moves into a source module, and the key is the COMPARISON

`packages/domain/src/shared/money-positivity-census.ts` exports:

- `stripComments(src: string): string` — moved **verbatim**. Grep `function stripComments(`.
- `extractComparison(codeLine: string): string | null` — **new.** Returns the matched comparison
  text from an already-comment-stripped line, **including the whole numeric literal**, or `null`.
  ⚠️ **It must choose between two possible matches by position, so it touches `a.index` / `b.index`,
  which are `number | undefined`** — `noUncheckedIndexedAccess` is on deliberately.
  ⛔ **RULES.md §13 row 206: prefer a GUARD to `!` on a regex match**, and where `!` is used a
  comment must name what makes it safe. The tempting `a.index! <= b.index!` is precisely what that
  rule exists to stop, because `!` silently switches the setting off at the point of use. **Write
  the guard.** ⭐ *(An implementation that never compares two `.index` values sidesteps this class
  entirely and is preferred — but the precedence rule below then becomes explicit, not incidental.)*

> ### ⛔⛔ PRECEDENCE — WHEN BOTH SHAPES MATCH ONE LINE, THE **OUTER** MATCH WINS
>
> **Exactly one site in the tree has both shapes on one line** — grep `an opening figure has to be`
> in `packages/domain/src/cutover/opening.ts`:
>
> ```ts
> if (!(Number(amount) > 0)) throw new Error('addOpeningFigure: …');
> ```
>
> | Precedence | Key it produces |
> |---|---|
> | inner first (`NUMBER_CMP`) | `Number(amount) > 0` |
> | ⭐ **outer first (`NEG_PAREN_GT`) — ADOPTED** | `!(Number(amount) > 0)` |
>
> ⛔ **Inner-first is a false green on the most dangerous edit this line can suffer.** Delete the
> `!` — `if (Number(amount) > 0) throw …` — and the guard **inverts**, from *refuse a non-positive
> opening figure* to *refuse a positive one*. Under inner-first **the key does not move**: still
> classified, still found, suite green, and an opening-figure guard now rejects exactly the values
> it was written to accept. Under outer-first the key changes, the site raises unclassified, and
> somebody has to look at it. **That is Invariant 2 doing its job.**
>
> ⭐ **The general rule, so it is not one site's special case:** when both shapes match, take the
> **longer/outer** match — it encodes more of the guarded expression, so it changes under strictly
> more semantic edits. **Measured cost: none — 46 keys and 3 collisions under either ordering.**
>
> ⚠️ **Both lanes independently chose inner-first and agreed with each other**, which is exactly why
> this needed a ruling rather than a convention: two sessions converging is not evidence of
> correctness when neither was asked the question. The tester's `CLASSIFIED` entry for
> `cutover/opening.ts` changes accordingly.
- `normaliseComparison(comparison: string): string` — collapse every whitespace run to one space,
  then trim. **Nothing else.** No lowercasing, no quote folding, no punctuation stripping: each of
  those makes two genuinely different comparisons collide.
- `censusKey(file: string, comparison: string): string` — `file` + `::` +
  `normaliseComparison(comparison)`.
  ⛔ **The file stays in the key** (DEF-376's own recommendation): the same comparison in two
  different modules is two different decisions. It is also what keeps
  `Number(after.outstanding) <= 0.005` in `cash-requests` distinct from the identical text in
  `liabilities`.
- `scanMoneyPositivitySites(rootDir: string): CensusSite[]`, where a `CensusSite` carries `file`,
  `line`, `raw`, `comparison` and `key`.
  ⛔ **`rootDir` is a PARAMETER, not a module constant.** That is what lets a test scan a fixture
  directory, and it is the only reason the extraction is worth doing.
  ⭐ **`raw` stays** — the untouched source line, comment and all. It is what the CLI prints and what
  a failure message shows. **Only `comparison` is hashed into the key.** Name the two fields so
  plainly that nobody can confuse *what we display* with *what we key on*.

**⛔ TWO SETS OF REGEXES, AND CONFLATING THEM IS THE MISTAKE TO AVOID.**

| Purpose | Regexes | May they change? |
|---|---|---|
| **Matching** — decides which sites are found | `NUMBER_CMP`, `NEG_PAREN_GT`, moved **verbatim** (grep the two anchors) | ⛔ **No.** Changing either changes the census, and this task changes no site. |
| **Key extraction** — decides what the key says | **new**, same two shapes but consuming `[0-9]+(?:\.[0-9]+)?` in place of the literal `0` | Yes — they are new in this task. |

⚠️ **The key-extraction pattern must never be used for matching.** It matches a superset (`> 5`
would match), and using it to decide membership would silently widen the census.
⭐ **The permanent protection is T7, not Invariant 4** — a widened census produces matches that are
in no table entry, and T7 raises on that loudly and forever. Invariant 4 is the *this-task* check and
stops existing the moment this commit lands; citing it as the safeguard (as revision 2 first did)
overstates what survives.

> **The one-pair alternative, considered and DECLINED on purpose — recorded so nobody rediscovers it
> and assumes it was missed.** A *single* pair, with the tail `0(?:\.\d+)?` in place of the literal
> `0`, is provably set-preserving (the optional group cannot fail where `0` succeeded) and was
> measured to give the identical 49-site set with the full literal captured. It would remove the
> two-pair drift class outright.
> ⭐ **We keep two pairs anyway:** this task's whole guarantee is that the **matching** regexes move
> **byte-identical**, so the census it produces is the audited one. A provably-safe edit is still an
> edit to the definition of the census, inside a commit that says it changes no site. The drift risk
> the one-pair option removes has already been converted into a hard error by the rule below.

⛔ **AND THE PAIRING MUST NEVER SILENTLY FAIL.** Every line the matching pair finds **must** yield a
comparison from the extraction pair — the extraction shapes are supersets of the matching ones, so a
`null` is impossible by construction *today* and would mean the two pairs have drifted apart
tomorrow. **A `null` for a matched line is a hard error that names the file and line, never a skip.**
⚠️ A silent skip would drop the site from the census entirely: no key, no `CLASSIFIED` entry
required, no unclassified hit raised — a guarded money comparison would simply stop being guarded,
and every test here would stay green. ⭐ **Observed empirically by the builder at spec review**
(49 matches, 0 null extractions); this makes it an assertion rather than a lucky property.

### 2. The guard test consumes the module, and the table is an ARRAY OF TRIPLES, not a keyed record

`CLASSIFIED` stays a hand-maintained table in the **test** file — a judgement table, not code.

⭐ **Its shape is `{ file, comparison, reason }[]`, with the key COMPUTED at runtime via `censusKey`
— not a `Record` whose keys are hand-joined strings.** Adopted deliberately, recorded here as a
decision rather than left to emerge:
- nobody hand-types a `file::comparison` string, so nobody typos one;
- §4's merged entries are natural in it;
- and a hand-joined key is a second spelling of the same fact, which is how the two drift apart.

⚠️ **This was a deviation the tester made from revision 1 and the auditor caught it.** It is an
improvement and it is approved — **but a silent deviation that happens to be an improvement is still
silent**, and the next reader comparing the file to the spec would have found them disagreeing. It
is written here so they agree.

### 3. The positive control is re-keyed to a comparison too

Grep the test name `positive control — a known, deliberately-unrouted rate check is still found`.
It must assert the scan finds the key for `customers/index.ts` + the comparison inside
`if (Number(input.rate) < 0) {` — **no line number anywhere in the assertion.** A control keyed by
position is not a control; renumber it onto any other matching site and it passes while controlling
nothing.

⛔⛔ **AND THE EXPECTED KEY IS A HAND-WRITTEN LITERAL, NEVER A COMPUTED ONE:**

```ts
expect(sites.some((s) => s.key === 'customers/index.ts::Number(input.rate) < 0')).toBe(true);
```

⚠️ **The natural implementation defeats the control.** Writing
`censusKey('customers/index.ts', extractComparison('if (Number(input.rate) < 0) {'))` derives the
expected value from the function under test — **if `extractComparison` is wrong, both sides of the
assertion are wrong in the same direction and the control passes while controlling nothing.** That
is the exact failure §3 exists to prevent, arriving by a new route: the old control was keyed by
position, this one would be keyed by the code it is supposed to be independent of.

⭐ Verified: `Number(input.rate) < 0` is what the adopted extraction yields there, and that text is
**unique in that file**, so the control cannot drift onto a neighbouring site. The literal encodes
the `::` separator and the normalised spacing deliberately — changing the separator later becomes a
visible one-line edit to the control rather than an invisible pass.

> ### ⛔ THE GENERAL RULE THIS IS AN INSTANCE OF — apply it to T9, T10 and T12 before writing them
>
> **Ask of every assertion: what value would have to be wrong for this to go red, and does the code
> under test supply that value?** If it does, the test cannot fail for the reason it was written.
> Three instances have already been caught in this one task — the line-keyed positive control, the
> vacuous Invariant 5 grep, and this one. They do not look alike and they are the same bug.

### 4. The 3 collisions are merged — and their multiplicity is DECLARED, not assumed

Each of the three keys in the table above covers **two** sites. Its reason must name **both**
enclosing functions, so the table still tells a reader every site the entry stands for.
⚠️ **Do not invent a positional tiebreaker** (no `#1`/`#2` ordinal): an ordinal reintroduces exactly
the fragility this task removes, because inserting an earlier identical comparison renumbers the
later one.

⭐ **A merged key would otherwise open a false-green hole** — a NEW site whose comparison is
byte-identical to an existing one *in the same file* would be silently covered instead of raising as
unclassified. That matters here because `Number(amount) <= 0` is the dominant idiom in this domain
(7 occurrences across 6 files), so within-file repetition is likely, not theoretical.

⛔ **So the count is declared and asserted.** A second, small table in the test file —
`EXPECTED_SITE_COUNT` — lists **only** the keys that legitimately cover more than one site, with the
number. **Three entries today.** The guard asserts:
- every key found at more than one site appears in `EXPECTED_SITE_COUNT` with the **exact** count;
- every key in `EXPECTED_SITE_COUNT` is still found at that many sites.

⭐ **The first direction sweeps all 46 keys, not only the 3 listed** — measured distribution is 43
keys at multiplicity 1 and 3 at multiplicity 2. So a second `Number(lineTotal) <= 0` appearing under
a *singleton* key takes it to 2, it is not in the table, **red**. A fourth in `loans/index.ts` takes
a declared 2 to 3, exact-count mismatch, **red**. The table stays three rows and the hole is closed
in both directions.

**Why this is not the DEF-376 reflex in new clothes — stated as the mechanism, not as a description.**
The honest argument is **trigger coupling**: this count can change *only* when a money positivity
comparison is added or removed, which is exactly the event the guard exists to force someone to
examine. The line-number key changed on **comment edits — three times in two days, not one of them
involving a money comparison.** (Revision 2 first argued this as "a count of the guarded thing, not
of where it sits". That is a description and it does not carry the weight: a line number is also a
fact about the guarded thing's context. The auditor's reframing replaces it.)

⛔ **But do NOT claim the reflex is eliminated.** Bumping `3` to `4` is still a one-token edit that
restores green without reading anything.
⭐ **So the mitigation is in the failure message: on a multiplicity mismatch the guard must print the
offending site's `file`, `line` and `comparison`.** Whoever bumps the number has then already been
shown the exact thing they are supposed to examine — **the reflex and the examination become the
same action**, which is the only version of this that survives a tired afternoon.

### 5. `CLASSIFIED` is re-keyed, never regenerated — and this is the riskiest step in the task

Each existing reason must land on the key for the **same** comparison it described.
⛔ **Do not dump the scanner's output into the table and hand-wave the reasons across.**
**Count it: 49 reasons in, 46 keys out, and exactly the 3 merges named above.**

> ### ⛔⛔ THE MIGRATION PROCEDURE — THIS IS THE SINGLE MOST LIKELY WAY THIS TASK SHIPS WRONG
>
> For **24 of the 49 sites** the old entry's text is not a substring transformation away from the new
> one. `if (Number(amount) <= 0) throw new Error('recordOrderWastage: …');` becomes
> `Number(amount) <= 0`; `settled: Number(after.outstanding) <= 0.005,` becomes
> `Number(after.outstanding) <= 0.005`. The **only** byte-correct source for those strings is the
> extraction pair itself — and §5 forbids dumping the scanner's output into the table. **Both rules
> are right**, and the resolution is narrow enough that a lane left to itself will pick one and
> breach the other:
>
> - ⭐ **The reason↔site PAIRING is preserved from the existing table and never re-derived.** That
>   pairing is the human judgement §5 exists to protect.
> - ⭐ **Only the comparison TEXT comes from the extractor**, joined to its existing entry **by that
>   entry's old `file:line`**.
>
> ⛔⛔ **AND THAT JOIN KEY IS A LINE NUMBER, ON A TREE THREE SESSIONS ARE WORKING IN.** If any file
> under `packages/domain/src` changes between the extraction and the commit, reasons land on
> **neighbouring comparisons** — silently. The key is present, the key is found, every gate is green,
> and the table now lies. That is §5's own blindness with a concrete trigger, and it is this day's
> line-number rule arriving inside the fix for the line-number defect.
>
> **So the join is MANDATORY against a pinned tree state, never the worktree:**
> 1. Extract comparisons from **`git show <pinned-sha>:<path>`**, not from the working copy.
> 2. Re-verify the 49-site baseline **immediately before** the migration and **immediately after**.
> 3. If the baseline does not match at either end, **stop and report BLOCKED** — do not reconcile it.
>
> **THE BASELINE, recorded here so it outlives any session's scratchpad.** 49 sites across 25 files,
> measured at **`d4bac7d`**, before any T-325 edit existed:
>
> ```
> ar/index.ts 63 · cash-requests/index.ts 54 110 412 · customers/index.ts 194
> cutover/index.ts 221 · cutover/opening.ts 69 · deliveries/documents.ts 121
> expenses/reimbursement.ts 46 53 · items/index.ts 183 184 · liabilities/index.ts 211 279
> loans/index.ts 93 168 175 199 218 227 253 315 · loans/interest.ts 65
> money-accounts/index.ts 232 · money-transfers/index.ts 158 182 · owners/index.ts 88 124
> pos/item-map.ts 46 · pos/plan.ts 121 · prepaid/index.ts 396 405 415 423 426
> recurring-expenses/index.ts 92 173 · remittance/allocate.ts 65 66 75
> remittance/index.ts 152 · sales-days/create.ts 321 · shared/straight-line.ts 58
> trade/index.ts 231 232 243 · wastage/orders.ts 293 · wastage/settlement-match.ts 108 109
> ```
>
> ⚠️ **Read those numbers as what they are: a photograph of `d4bac7d`,** valid as a join key only
> against that tree. The `file:line` pairs are what Invariant 4 compares; **the count of 49 and the
> per-file grouping are what survive an edit** — check those two first if the pairs ever disagree.

⛔⛔ **BUT A COUNT CAN BALANCE WHILE TWO ENTRIES HAVE SWAPPED.** Every assertion in this guard is
key-**presence** only, so a reason silently reattached to the wrong comparison passes every gate:
both keys exist, both are found, the suite is green, and the table now lies. That is the register's
own 2026-09-19 amendment about this guard, and §5 would otherwise inherit its blindness into the one
operation where it matters most.

**How the pairing is checked — and the two halves are not the same strength:**

- ⭐ **TESTED (T11).** A meaningful subset is mechanically checkable: **21 of 49 reasons name a
  function defined in their own file**, and **19 of 49 backtick an identifier**, 12 of which appear
  in the guarded comparison itself. Where a reason backticks an identifier that the key's comparison
  also contains, assert it. Where a reason names a function, assert that function exists in that
  file. ⚠️ **Two reasons name an INNER function** (`runCreate` inside `createMoneyTransfer`,
  `runWriteOff` inside `writeOffPrepaidItem`) — the table is correct and a naive
  top-level-export check is what is wrong. Handle them or exclude them **by name**, never by
  loosening the assertion.
- ⚠️ **AUDITED, WHICH IS WEAKER.** The remainder is covered by the auditor reading the `CLASSIFIED`
  diff line by line against the pre-change census.
  ⛔ **It is not booked as tested.** Saying "the re-key is verified" when ~60% of it rests on a
  careful read is the substitution this project keeps getting caught by.

**And the re-key must not leave positional claims behind inside the reasons it moves.** These read
as pointers to keys that will no longer exist, and must be rewritten to name the comparison or the
function instead:

| Where | The dangling claim |
|---|---|
| `prepaid/index.ts` reason (×2) | "same `refunded` as :405" |
| `wastage/settlement-match.ts` reason | "same as :108" |
| the guard's header, blind spot (4) | cites `cash-requests/index.ts:54` |

The header is already being edited — **do all of it in one pass.** The full list of header edits:

1. §4's multiplicity limitation and the `EXPECTED_SITE_COUNT` mechanism.
2. The three dangling `:NNN` reason pointers above, and blind spot (4)'s `cash-requests/index.ts:54`
   citation, rewritten to name comparisons or functions.
3. **Blind spot (5) — a comparison split internally across lines** (`Number(\n amount\n) > 0`) stops
   matching altogether. A limit of the line-based scanner, not of the key.
4. ⭐ **Blind spots (6) and (7) — TWO PRE-EXISTING STRIPPER HOLES THE AUDITOR MEASURED, neither
   introduced by this task and neither currently documented anywhere.** The stripper deliberately
   leaves string literals alone (its own comment says so, as a knowing trade) — but **the
   consequence of that trade is written nowhere the next reader will find it**:
   - **(6)** a string containing `//` *before* a comparison on the same line **kills that site
     outright**: `const u = 'http://a'; if (Number(x) <= 0) {` is **not found**.
   - **(7)** a string containing `/*` blanks everything to the next `*/`, **removing sites in a
     range** — a real comparison two lines below a `const s = '/*';` is not found.
   ⚠️ **Live today? No site is currently lost.** Only two lines in all of `packages/domain/src` are
   stripper-suppressed and both are genuine JSDoc prose quoting `Number('0.004') > 0`
   (`shared/money-input.ts`, `shared/money-lines.ts`) — correctly suppressed. But the mechanism is
   live: grep `memory://` in `files/driver.ts` for a string carrying `//`, harmless only because
   nothing else shares its line.
   ⛔ **Document them; do not fix them.** Fixing the stripper changes which sites are found, and
   Invariant 4 forbids that in this task. They are a future defect row, not this task's work.

### 6. The module gets a real caller: `scripts/money-positivity-census.ts`

A `tsx` script that scans `packages/domain/src` and prints each site as `file:line  raw`, plus the
total. **Scope it to scan / print / exit code and nothing else.**

> ### ⛔ CORRECTION — `--check` IS REMOVED, AND IT WAS UNBUILDABLE AS SPECIFIED
>
> Revision 2 said `--check` *"exits non-zero when something is unclassified."* **It cannot.** `CLASSIFIED`
> lives in a `.test.ts` file by §2's design, and a script under `scripts/` cannot import a test file —
> so the CLI has no way to see the classification table, and nothing it scans can ever be
> "unclassified" from its own information. Found by the builder, which stopped and asked rather than
> quietly picking a reading. **Stale language of mine, left over from before §2's test-file-only
> table was settled.**
>
> ⛔ **And the fix is NOT to give the CLI its own copy of the table.** T7 already asserts every site
> is classified, in the unit suite, where it runs on every commit. A second copy is a second source
> of truth and the two will drift — the argument `RULES.md` §6 makes about re-implementing database
> constraints in TypeScript, and it applies here unchanged.
>
> ⭐ **What the CLI does instead:** scan, print every site and the total, and exit non-zero only on a
> **structural** failure — the scan throws, or it finds **zero** sites (the DEF-179 floor: *a scan of
> nothing passes*). ⛔ Spelled `=== 0`, never `!(… > 0)` — see Invariant 4.
> ⚠️ **No hard-coded expected count of 49 in the CLI.** That number is a fact about today's tree; a
> CLI asserting it would go red on the first legitimate new money comparison, which is the
> maintenance-reflex trap this whole task exists to remove.

⭐ **Why it is in scope, stated precisely — revision 1 overstated this and the auditor corrected it.**
`callers.mjs` has four statuses, and `internal` (a symbol used more than once inside its own file)
**passes**; only `zero` and `test-only` fail. `stripComments`, `extractComparison`,
`normaliseComparison` and `censusKey` are each used by `scanMoneyPositivitySites` within the module,
so they land on `internal` and would pass with no CLI at all. **The gate failure is exactly one
export: `scanMoneyPositivitySites`.** It is still a real failure — the DEF-129/135/136/137/147 shape,
five tasks once marked done with zero callers — and the extraction is the only way to get T1–T5
against a fixture directory. **So: build the CLI, keep the extraction.**

⚠️ **Two corrections to revision 1's supporting claims, both from the auditor:**
- `scripts/production-caller-census.mjs` is precedent for *"a census script exists"*, **not** for
  *"a census script imports a domain module"* — it reads source text with `node:fs` and is fully
  self-contained. The precedent is thinner than revision 1 implied. (This is **not** an argument for
  moving the scanner into `scripts/`, which would invert the dependency and have a package's test
  reaching into repo tooling.)
- **DEF-379 is not a blocker and no exports-map change is needed.** Six scripts already import via
  relative `../packages/domain/src/...` paths, bypassing the exports map entirely.

**Import paths — the two consumers differ, deliberately:**
- **CLI:** `@shareat/domain/shared/money-positivity-census`, resolved by the `"@shareat/domain/*"`
  wildcard in `tsconfig.json` (verified under `npx tsx` and `npx tsc --noEmit`). A relative
  `../packages/domain/src/...` import is equally acceptable and matches six existing scripts.
- ⛔ **TESTS: relative — `./money-positivity-census`. Never the alias.** `vitest.config.mts` resolves
  `@shareat/*` through its own hand-written map with **no wildcard** (three exact-match entries).
  ⚠️ A test using the alias would fail to resolve, and **that failure looks like a red and is not
  one** — it would corrupt the very distinction the RED step depends on.
- ⛔ **Neither lane widens `vitest.config.mts` or `packages/domain/package.json` to make this
  uniform**, and the strongest reason is not the one revision 1 gave. `vitest.config.mts`'s alias
  map is **hand-ordered with exact-match semantics**, and carries an in-file warning that the
  subpath entry must precede the bare name for exactly that reason. **Adding a wildcard changes
  module resolution for every unit-test file in the repo**, has nothing to do with T-325, and
  **cannot be validated by anything this task tests.** That is a reason to refuse even if DEF-379
  did not exist. (It also happens to be DEF-379's work, owned by a separate task — the weaker of the
  two arguments, kept because it is still true.)
- ⛔ **And DEF-379 is NOT a prerequisite to be done first.** It is a shipped-public-surface change
  plus a sweep of `apps/`. T-325 needs no subpath at all — the CLI goes through the tsconfig
  wildcard, the tests go relative — so sequencing DEF-379 ahead would couple a guard-maintenance fix
  to a public-surface change and an app-layer sweep, for no benefit to either. **Keep them
  separate.**

### 7. The new module is a dev tool living in a shipped package, and must say so

The scanner moves **into** `packages/domain/src`, so the domain package gains a module that imports
`node:fs` and walks the filesystem. It is inert today — not in the barrel, nothing imports it — but
**one future barrel re-export puts `readdirSync` into the app bundle.**

⛔ **Require a header line on the new module** saying it is development tooling, that it must never
be re-exported from `packages/domain/src/index.ts`, and why.

## Invariants — the ones worth a test rather than a reading

1. **The same comparison keeps its key when unrelated lines move above it.** DEF-376 itself.
2. **The key changes when the COMPARISON changes** — operator, operand, or the numeric literal
   (including a tolerance going from `0.005` to `0`). A key that survives a change to what it guards
   is worse than a line number.
3. **The key does NOT change when anything else on the line changes** — a re-worded error message, a
   template literal's contents, a trailing comment, re-indentation, internal spacing, or the
   comparison being reflowed onto its own line within a multi-line statement.
   ⚠️ **Stated as what it is:** a comparison split *internally* across lines (`Number(\n amount\n) > 0`)
   stops matching altogether and is a **known limit of the line-based scanner**, not of the key. It
   is blind spot (5) — record it in the header beside the existing four; do not claim this invariant
   covers it.
4. **The set of sites found is unchanged by this task.** Before and after, the scan finds the same
   file-and-line pairs — **49 of them**, and the baseline is recorded in §5.
   ⛔⛔ **AND THE NEW MODULE IS ITSELF INSIDE THE SCANNED DIRECTORY.** `money-positivity-census.ts`
   is a non-test `.ts` under `packages/domain/src`, so **the census scans its own scanner.** Write
   one `if (!(count > 0))` or one bare `Number(x) > 0` in it and the census becomes **50 sites**, the
   extra one unclassified, the guard red — pointing at the census module itself.
   ⭐ **Measured, so this is a caution and not a veto:** a natural implementation produces **zero**
   self-matches, because a regex *literal* spells it `Number\(` (escaped) and `!IDENT.test(...)` is
   not `!(`. **But it is one careless line away**, so: after building, run the scan and confirm it
   still returns **49**. If it returns 50, the fix is to reword your own code — ⛔ **never to add
   your module to the skip-list**, which would blind the guard to a real directory.

   ⛔⛔ **AND THE SPELLING IS AN INSTRUCTION, NOT A CAUTION, BECAUSE THIS REPO'S OWN CONVENTION WALKS
   INTO IT.** The repo *requires* an empty-scan guard — DEF-179, *"a scan of nothing passes"*, an
   explicit test in `client-bundle-boundary` and `domain-actions-have-callers` — so the builder is
   **likely** to write one, and the idiomatic negated spelling is the self-match. Measured against
   the live matchers:

   | Spelling | Result |
   |---|---|
   | `if (sites.length === 0) throw new Error(...)` | ✅ safe — **use this** |
   | `if (matches.length <= 0) return []` | ✅ safe |
   | `if (line > 0) keep()` | ✅ safe |
   | `if (!(sites.length > 0)) throw new Error(...)` | ⛔ **MATCHES — the one that will actually happen** |
   | `if (!(count > 0)) bail()` | ⛔ MATCHES |
   | `if (Number(process.argv[3]) > 0) run()` | ⛔ MATCHES — **and the CLI parses argv** |

   **Write `=== 0`. Never `!(… > 0)`.**
5. **No key carries a positional component**, and **the check for it must be capable of failing.**
   ⛔⛔ **REVISION 1 STATED THIS AS "grep the finished `CLASSIFIED` for a key ending in a colon and
   digits — zero hits", AND UNDER §2's ADOPTED SHAPE THAT GREP IS VACUOUS.** There are no literal
   key strings in the file at all, so it returns zero hits whether the re-key is complete or not.
   **It passes by having no input to fail on** — the same shape as the docs-only CI run in
   `HANDOFF-TODAY.md` §4a that went green while testing nothing. Caught by the auditor.
   ⭐ **So it is asserted over the COMPUTED keys and the `comparison` values**, both of which exist
   at runtime: no computed key and no `comparison` ends in `:<digits>`, and no `reason` string
   contains a `:<digits>` pointer (§5's dangling-pointer table).
   ⛔ **And the demonstration that it can fail is a PERMANENT NEGATIVE TEST, not a one-time manual
   act.** Hand the predicate a fabricated positional value **directly**, without mutating the real
   table, and assert it rejects it. ⚠️ "Feed the real table a bad entry, watch it go red, remove it"
   is one session's private act: it leaves no artifact, it can be forgotten, and the fabricated entry
   can be left behind. A permanent negative test costs the same and cannot rot.
   ⭐ **RULING, stated so nobody later reads it as a false positive:** a `reason` may **never**
   legitimately cite a line number. If one wants to, the reason is reworded — **the check is not
   loosened.** Recorded here because in six months this will look like an over-strict assertion.

## Tests — the tester writes these, and the shapes below are mandatory

**In `money-positivity-census.test.ts` (new), against a FIXTURE directory the test creates in a temp
dir — never against `packages/domain/src` itself:**

- **T1 — stability (Invariant 1).** One matching comparison in a fixture; record the key. Rewrite
  with **five comment lines inserted above**; scan again. ⭐ **Assert the key is identical AND that
  the reported `line` has changed** — the second half proves the fixture actually moved and the test
  is not passing vacuously.
- **T2 — sensitivity (Invariant 2).** Change `<=` to `<` → key differs. Change the operand → key
  differs. ⭐ **Change `0.005` to `0` → key differs.** That third case is the one revision 2 exists
  for; without it the tolerance blind spot ships.
- **T2b — payload is NOT part of the key (Invariant 3).** Give the fixture's comparison a trailing
  `// …` comment and a `throw new Error('…')` on the same line. Record the key. **Re-word only the
  message, then only the comment, then delete the comment** — the key must be unchanged all three
  times. ⭐ **This is the regression test for the defect that made revision 1 wrong**, and 24 of 49
  real sites depend on it.
- **T3 — whitespace and reflow (Invariant 3).** Re-indent and collapse internal spacing → same key.
  Then reflow so the comparison sits on its own line inside a multi-line statement → same key.
- **T4 — the file half of the key.** Two fixture files with identical comparison text → different keys.
- **T5 — comment stripping survives the move, at BOTH comment boundaries.** A comparison commented
  out with `//` is not found. A comparison inside a `/* … */` block is not found. ⭐ **And the
  boundary case:** a `/* … */` **opened on the same line as a live comparison** must leave that
  comparison found and its key unchanged — the stripper blanks from the comment opener onward, so
  the comparison before it survives. ⚠️ Raised by the auditor as unverified in revision 1; it was
  reasoned about and not tested. Test it.

**In `money-positivity-guard.test.ts` (re-keyed):**

- **T6** — the count floor stays.
- **T7** — every match's key is classified.
- **T8** — no stale entry: every `CLASSIFIED` key matches **at least one** site.
- **T9** — the positive control, keyed by comparison (§3).
- **T10** — Invariant 5, over the **computed** keys and the `comparison` values, never by grepping
  for literal key strings (there are none — see Invariant 5). ⛔ **Prove it can fail before you
  trust it**: add one fabricated positional entry, watch it go red, remove it.
- **T11** — the reason↔site pairing, on the mechanically checkable subset only (§5). ⛔ Name in the
  test what it does **not** cover, so the next reader does not mistake it for full coverage.
- **T12** — `EXPECTED_SITE_COUNT` (§4), both directions.

⛔ **The tester reads its own red output and reports WHY each test fails.** A test failing because
`money-positivity-census.ts` does not exist yet is **not** a usable red — it proves only that an
import is missing. Say plainly which reds are "module absent" and which land on the assertion that
matters.

## §9.4 — the screen test, and what it honestly is here

⛔ **This task has NO rendered surface.** It changes a unit-test guard and a dev CLI. **Reporting
"smoketested the screen" would be false.**

What is required instead:
- **The orchestrator** starts the dev server on **9008** and confirms the app boots and serves,
  proving the extraction broke no module the app imports transitively.
- **The orchestrator** runs `scripts/money-positivity-census.ts` and reads its output. A CLI never
  executed is the `test-only` problem wearing a different hat.
- ⭐ **The acceptance, and THE ORCHESTRATOR IS THE ACTOR — not a lane.** Add a blank line at the top
  of `packages/domain/src/remittance/index.ts`, run the guard, confirm **still green**, revert.
  ⚠️ That file is inside both lanes' do-not-touch fence; a lane doing this would breach its fence and
  trip `callers.mjs --forbid`. **I do it.**

⚠️ **Sign-in on this machine is a known constraint, not a surprise:** all five
`NEXT_PUBLIC_FIREBASE_*` values in `.env.local` are empty, and DEF-371 records that `/sign-in` has no
emulator path of its own. **Because this task has no screen, that does not block it** — stated so
nobody records a screen test that did not happen (bible row 203: an unmet gate goes to Ian in plain
words, and the silence is the defect, not the gap).

## Out of scope — named, so nobody widens into them

- ⛔ **Changing any guarded comparison** in `packages/domain/src`. Not one.
- ⛔ **Changing the MATCHING regexes**, the set of files walked, or the skip-list.
- ⛔ **Re-classifying any site.** Reasons move across unchanged, except §4's three merges and §5's
  dangling-pointer rewrites.
- ⛔ **The guard's known blind spots.** This task adds (5) to the header and closes none of them.
- ⛔ **DEF-379, DEF-378, DEF-374, DEF-380.** Separate work, separate passes.
- ⛔ **Moving the guard test** to `tests/unit/`, or moving the scanner to `scripts/`. Both considered
  and rejected above.

## Done when

Every §9 gate: typecheck clean · unit suite green (**not just this file**) · integration green on the
lane database (this task adds none, but the suite must still pass) · `npm run build` with the dev
server stopped · the auditor's `/code-review` returned and triaged · **the auditor's line-by-line
read of the `CLASSIFIED` diff returned**, and reported as *audited*, never as *tested* ·
`callers.mjs` clean, **including that `scanMoneyPositivitySites` reports `ok` and not `test-only`** ·
the §9.4 items above, run by the orchestrator · committed with a message saying *why* ·
**DEF-376 marked closed and the roadmap made true — by the orchestrator, not by a lane.**

⚠️ **One for the orchestrator, outside the lanes:** DEF-376's own register row cites the guard
holding the key `'remittance/index.ts:125'`. The live entry is `:152`. **The row documenting the
stale-number defect has itself gone stale twice over** — fix it when closing the row, and note that
after this task the row's remedy is satisfied and its example no longer exists in that form.
