# T-312 — fourteen shipped tasks have files whose leading status claim still says unstarted

> ### ✅ **Status: SHIPPED 2026-09-14 in `9eaaf55`** — the guard plus all fourteen banner repairs.
> See `docs/ROADMAP.html` (search `T-312`) for the outcome.
>
> ⛔ **And this banner itself read *"SPEC v2 — Awaiting APPROVED"* for hours after shipping — the
> guard's own subject, on the guard's own file.** It was invisible to the guard for the same reason
> T-311's was: no roadmap row, so not in the done-set (DEF-352). ⭐ **The fix was the roadmap pass,
> not the guard** — which is exactly why the wrap-up ritual requires the roadmap every time.
>
> **Spec v2 by lane B (`webapps-4e`, Sonnet 5), 2026-09-14.** Reserved
> 2026-09-14 by the orchestrator (`system32-85`) at wrap-up (DEF-348). v1 of this spec claimed 19
> (then 21) files needed repair; system32-85 measured the leading status line of all nineteen
> independently and found seven were already correct — DEF-348's own headline claim about
> `130-accounts-payable.md` was false. v2 incorporates that correction.
>
> ⭐⭐ **THIS FILE PREDICTED THAT IT WOULD BE THE GUARD'S FIRST HONEST HIT, AND IT WAS — WITHIN
> HOURS, DURING THE SAME DAY'S WRAP-UP.** The spec said, before the guard existed, that it would be
> the first file flagged "once T-312 ships and the roadmap marks it done". Both happened on
> 2026-09-14: the guard shipped in `9eaaf55`, the wrap-up added the roadmap row, and the very next
> run failed naming this file for the phrase "NUMBER RESERVED" sitting in the sentence above.
>
> ⚠️ **The prediction was written in backticks, and backticks are not quotation marks** — so the
> guard's quote-stripping did not treat it as historical, correctly: a code span is not a claim
> about the past. The sentence is now in the past tense and the phrase is quoted, which is the
> remedy the guard's own failure message offers. **Not special-cased, not exempted.**
>
> ⭐ **What it demonstrates is worth more than the fix:** the guard caught the one file whose author
> had explicitly warned it would be caught, on the day both conditions came true. Nobody had to
> remember.

## Goal

Fourteen `docs/tasks/*.md` files have, as their **leading status claim**, a statement that the
task is unstarted (`Number reserved`, `SPEC — awaiting APPROVED`, `not yet implemented`) while
`docs/ROADMAP.html` marks the same task `t-done`. This task builds a standing guard against the
class **and** repairs the fourteen, in one pass, so a single hand-fix (DEF-122's, 2026-09-02) does
not rot back to wrong a second time with nobody watching.

## What changed from DEF-348's own count, and why it matters to the mechanism

DEF-348 measured 19 by matching a phrase list against each file's first ~12 raw lines. That
over-counts, and re-deriving it here (not re-typed from the register — measured against the real
files) is why: **seven of the nineteen already lead with a correct SHIPPED/BUILT status** and only
match the phrase list because they *quote their own former stale banner* further down, either as
an inline quotation (`"…"`) or under an explicit `ORIGINAL STATUS:` label — a convention four of
them already use for exactly this purpose. A guard that fires on those seven would demand seven
edits that delete real, load-bearing content to silence a false alarm. The seven, with why each is
a false positive:

| id | leads with | why it still phrase-matched |
|---|---|---|
| T-130 | `BUILT 2026-08-28 (\`f438316\`) — this line was stale.` | quotes its own old line: `"Spec ready, not yet implemented."` |
| T-256 | `SHIPPED \`0a984eb\`, 2026-09-10 — lane E.` | quotes: `"SPEC — awaiting APPROVED … nothing below is built"` |
| T-257 | `SHIPPED \`d162380\`, 2026-09-10 — lane B.` | labelled `ORIGINAL STATUS, kept for the record: RESERVED…` |
| T-258 | `SHIPPED \`eba3c15\`, 2026-09-10 — lane D.` | labelled `ORIGINAL STATUS: RESERVED…` |
| T-259 | `SHIPPED \`ccef651\`, 2026-09-10 — lane E.` | labelled `ORIGINAL STATUS: RESERVED…` |
| T-260 | `SHIPPED \`ccac49d\`, 2026-09-10 — lane E.` | labelled `ORIGINAL STATUS: RESERVED…` |
| T-304 | `SHIPPED, DEPLOYED AND CUT OVER — 2026-09-13.` | quotes: `"SPEC ONLY, no code — awaiting APPROVED"` |

(T-260 and T-304 are the two files v1 of this spec asked to *add* to the repair list, having found
them the same way DEF-348 found its nineteen — by matching anywhere in the banner. Both are false
positives for the same reason as the other five. The scope amendment is withdrawn.)

⛔ **DEF-122's row is also corrected by this measurement**: it was fixed 2026-09-02, four days
after filing, and has been correct since — its row's claim that T-130 "is still stale today" does
not hold against the file. That correction is system32-85's edit to make (register is out of
scope here), noted so it isn't lost.

## Scope

New: `tests/unit/task-status-banner.test.ts` (self-contained — no new script file; matches
`tests/unit/deferral-staleness.test.ts`'s precedent of inline extraction logic, not
`toc-freshness.test.ts`'s, which delegates to a pre-existing generator this task has no equivalent
of).

Edited: the **leading status claim only** — not the whole banner, not anything below it — in
these fourteen files, every one confirmed to genuinely lead with an unstarted claim:

T-196, T-235, T-238, T-244, T-247, T-248, T-250, T-281, T-285, T-289, T-298, T-299, T-305, T-306.

`130-accounts-payable.md` is OFF this list. Nothing in it needs to change.

## The assertion

**A task the roadmap marks `t-done` must not have, as its leading status claim, a statement that
it is unstarted.** Not "must not contain the phrase anywhere" — that was DEF-348's over-broad
version and it is what produced seven wrong edits before anyone read the raw text.

1. Parse `t-done` ids out of `docs/ROADMAP.html`: `<div class="task t-done"><div class="task-id">…`,
   which may name more than one id in a row (`T-303 · T-304` → both ids).
2. Derive each `docs/tasks/*.md` file's id from its numeric filename prefix.
3. For every file whose id is in the done-set, extract its **leading claim** (mechanism below) and
   flag it if that text — and only that text — matches
   `AWAITING APPROVAL|SPEC NOT YET WRITTEN|NUMBER RESERVED|not yet implemented|awaiting APPROVED|Number reserved`
   (case-insensitive; DEF-348's own phrase list, reused verbatim).

⚠️ **The roadmap is the authority; a task file is written once and abandoned.** The guard
re-derives the done-set and re-scans every task file every run — never hardcoded to fourteen
filenames, or a fifteenth instance next month is invisible to it by construction.

## Mechanism, and why it needs three fixes plus one exclusion rule

Start from the leading run of `>`-blockquote lines under the `# T-NNN` title (a blank
blockquote-continuation line doesn't end the run; a non-`>` line does), CRLF-normalised.

**Fix 1 — DEF-179 (CRLF).** `.` doesn't match `\r` on this repo's CRLF checkout. Every read is
`.replace(/\r\n/g, '\n')` before any line-oriented regex, both for the roadmap and the task files —
`deferral-staleness.test.ts`'s own reason, cited there.

**Fix 2 — strip each line's leading `>\s?` before joining, not after.** `256-*.md`'s quoted phrase
is split `…said "SPEC — awaiting` / `APPROVED … nothing below is built"…` across two physical
lines. Joining with `' '` alone still misses it, because every continuation line begins `> `, so a
naive join reinserts the marker between the two halves (`"…awaiting > APPROVED…"`, unmatched).
Stripping first, then joining, recovers it. **This one cuts against a lenient guard**: without it,
`256-*.md` reads as clean when it is one of the seven that legitimately still needed inspecting
(just not repairing) — measured directly by running both orders and comparing.

**Fix 3 (this revision) — a quotation or an explicit `ORIGINAL STATUS` label is not the file's own
present claim.** Two conventions already used in this corpus to preserve a corrected file's
history: an inline quotation in `"…"` (T-130, T-256, T-304) and an explicit `ORIGINAL STATUS:` /
`ORIGINAL STATUS, kept for the record:` label (T-257, T-258, T-259, T-260). Both mean "what
follows is what this file USED to say," and the phrase list must not be matched against either.
**Verified against all 157 done-set files, not just the known 21**: stripping `/["“][^"”]*["”]/g`
spans, then truncating at the first case-insensitive `original status`, then matching the phrase
list against what remains, reproduces exactly system32-85's fourteen — no more, no fewer,
everywhere in the corpus, not only in the files already under discussion.

```
function leadingClaim(bannerText) {
  const noQuotes = bannerText.replace(/["“][^"”]*["”]/g, '');
  const cut = noQuotes.search(/original status/i);
  return cut === -1 ? noQuotes : noQuotes.slice(0, cut);
}
```

⚠️ **This does not attempt to find "the first sentence."** Tried and measured wrong: a plain
first-`.`-then-whitespace split over-extends on T-130 (a quoted phrase's own internal period isn't
followed by whitespace, so the naive split runs past it into the real trigger text) and
under-extends on T-235/T-238/T-250, whose genuine leading claim is a short *paragraph* of several
sentences inside one bold span (`SPEC — lane B, 2026-09-08. Written before any code. Awaiting
APPROVED.`), not one sentence. Quote-stripping plus the `ORIGINAL STATUS` cut is what actually
tracks this corpus's own convention for marking a claim as historical, rather than guessing at
prose boundaries it doesn't reliably have.

⚠️ **Recorded so the next person doesn't have to re-discover it: this makes `ORIGINAL STATUS` a
load-bearing label, not merely a stylistic habit.** Recommend (not required by this task) that
future banner corrections that keep a stale quote for the record use exactly that label, since the
guard now treats it as the boundary.

## Known limitation, accepted (system32-85's refinement 2)

Quote-stripping can produce a false negative: a genuinely stale leading claim written inside
quotation marks for emphasis — e.g. a banner opening `Status: "awaiting APPROVED"` with no
`ORIGINAL STATUS` label and no actual shipment — would be stripped along with the legitimate
historical quotations and the guard would stay silent on it. **Measured, not assumed**: zero of
the 157 done-set files do this today. Not worth coding around, because the alternative is guessing
at prose boundaries — exactly what the rejected first-sentence split did, and it was wrong in both
directions (over-extended on T-130, under-extended on T-235/T-238/T-250). Written down here as an
accepted limit rather than left for the next reader to discover as a surprise: if this ever
produces a false negative, the fix is to require quotation marks to co-occur with an attribution
verb (`said`, `read`, `replaces`) before stripping them, not to abandon quote-stripping outright.

## The repair — leading claim only, everything below it byte-for-byte

Convention, replacing **only the leading-claim span the mechanism above extracts** — not the whole
banner:

```
**Status: SHIPPED.** See `docs/ROADMAP.html` (search `T-NNN`) for the commit, date and outcome —
the roadmap is the maintained record.
```

Checked per file, not assumed uniform: for T-196, the claim to replace is exactly `Spec ready, not
yet implemented.` — the following `**Depends on:** T-122…, T-130…, T-141…. **Blocks:** nothing.
**Written by:** Opus…` is untouched, because that is precisely the cross-task dependency
information DEF-122's own history says a reader needs (T-170 depended on knowing T-130's real
state). For T-235/T-238/T-250, whose claim spans several sentences in one bold run, the whole
bold run is the replaced span and the blockquote's second paragraph (the substantive finding) is
untouched. Each of the fourteen gets this treatment individually in BUILD, not a blanket
find-replace — a script doing this mechanically across fourteen differently-shaped banners is
more likely to eat a dependency note than to save the time of doing it by hand fourteen times.

**Why leading-claim-only, not the whole banner (v1's mistake).** v1 proposed replacing the entire
opening blockquote, reasoning that the roadmap already carries the same detail. Checked against
these fourteen specifically and it's false for several: `196-*.md`'s `Depends on`/`Blocks` fields
name relationships the roadmap's own entry for T-196 does not carry at all (the roadmap has no
per-task dependency graph). Deleting them would be a real information loss the roadmap cannot
absorb, not a redundant copy of something maintained elsewhere. Leading-claim-only avoids the
question entirely: it fixes exactly the sentence that is false and touches nothing else.

## Invariants / tests

1. **Non-vacuity (DEF-179's own lesson, applied to this guard):** the roadmap done-set and the
   task-file count are both `> 0`. A scanner silently finding neither would report a spotless
   guard for the worst possible reason.
2. **The real assertion:** no `docs/tasks/*.md` file whose id is `t-done` has a leading claim
   matching the phrase list. **Failure message names both remedies, not just the fault**
   (system32-85's refinement 1) — the id, file and matched phrase, THEN one line stating the two
   ways to fix it: either the leading claim is genuinely stale and should be repaired to
   `Status: SHIPPED…`, or the flagged text is historical and should be marked the way this corpus
   marks history — quoted in `"…"` or placed after an `ORIGINAL STATUS:` label — so it stops being
   read as the file's own present claim. Fix 3 makes `ORIGINAL STATUS` load-bearing; the guard is
   now the only thing that knows that, so it says so at the point of failure rather than assuming
   the reader has read this spec.
3. **MUST-NOT-FIRE control (this revision, the half v1 didn't have):** the guard stays SILENT on
   all seven false positives, named individually with the one-line reason each is safe — `T-130`
   (quotes its former line), `T-256` (quotes its former header), `T-257`/`T-258`/`T-259`/`T-260`
   (each carries an `ORIGINAL STATUS:` label), `T-304` (quotes its former line). **This is the
   control that would have caught v1's mistake before it shipped seven wrong edits** — a guard
   proven only to fire is half-tested, per RULES §3.2 ("a test that only ever passed proves
   nothing," read in the direction of a guard too eager to fail).
4. **CONTROL — the detector still fires on a real positive:** synthetic done-shaped banner whose
   leading, unquoted, unlabelled text is `Number reserved` — asserts it fails. Guards the
   opposite failure from (3): a detector narrowed enough to pass the seven must not have been
   narrowed into passing everything.
5. **CONTROL — the repaired convention is clean:** the exact replacement text above, run through
   the same extractor, does not match. Pins the convention so a later edit to the phrase list
   can't silently break it.
6. **Multi-id row parsing:** synthetic `<div class="task t-done">` naming two ids in one row
   yields both — pins `T-303 · T-304`'s shape.
7. **CRLF regression:** identical fixture text once as `\n`, once as `\r\n`, produces identical
   `leadingClaim` output — direct pin of Fix 1.
8. **Blockquote-join regression:** a synthetic banner split exactly like `256-*.md`'s
   (`…said "SPEC — awaiting` / `APPROVED …"` across two `>`-lines) is, correctly, NOT flagged
   (it's a quoted false positive) — but the same split with the quote marks removed IS flagged.
   One fixture pair pins Fix 2 and Fix 3 together and shows they're independent: Fix 2 alone
   would flag both; Fix 3 alone (without the join fix) would flag neither.

## Findings logged in passing, not fixed here (RULES §13 row 164)

- **`T-148`** (Item governance) is `t-done` with no `docs/tasks/*.md` file at all — a different
  failure shape (nothing to open a banner in), out of this guard's reach by construction.
  system32-85 is filing this as **DEF-349**; this guard adds no file-existence check for it.
- **DEF-122's and DEF-348's rows** need correcting to reflect this measurement — system32-85's
  edit, per the register boundary; described here so it isn't dropped.

## The inverse inventory (roadmap-not-done task files)

Requested separately for the trial-launch checklist, not part of this guard's contract — a
one-time report, not something worth asserting on continuously. Hand-produced as a plain table in
this lane's `[B] READY` message, per the briefing, once `doneIds()` exists (it's the complement).

## Out of scope

- `docs/ROADMAP.html`, `PROJECT_BIBLE.md`, `docs/DEFECTS-REGISTER.md`, `docs/HANDOFF-TODAY.md`,
  `docs/RULES.md` — read-only for this lane.
- Any `docs/tasks/*.md` file not on the fourteen above (`T-130`, `T-256`–`T-260`, `T-304`
  explicitly excluded — confirmed correct as written).
- A machine-readable status token — assessed in v1, rejected; the reasoning is unchanged by this
  revision (a token would touch ~207 files and duplicate the roadmap's own authority).
- `T-148`'s missing task file or its register row (DEF-349, system32-85's).
- The inverse (not-shipped) inventory as a file or a test — reported in prose only.

## Done when

`tests/unit/task-status-banner.test.ts` exists (only new file); its first run is RED against the
fourteen unrepaired banners and that real output — including confirmation the seven false
positives stay silent — is captured before any banner is touched; each of the fourteen leading
claims is then replaced per the convention, everything else in those files byte-for-byte
unchanged; `npm run test` and `npm run typecheck` both green; nothing else modified.
