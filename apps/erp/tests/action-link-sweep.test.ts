/**
 * T-262 / DEF-269 — replaces the old text-matcher (`text-xs` + bare `underline`) with an
 * authored-box-geometry guard. See `touch-target-geometry.ts` for the model and the two
 * definitions (interactive control, opaque-component allowlist) it states explicitly.
 *
 * `text-xs` stops being the subject; `underline` stops being mentioned at all — both were spelling,
 * never the actual WCAG 2.5.8 rule (a box height). DEF-239/DEF-243/DEF-269 are all subsumed: each
 * was "a box under 24px", found three different ways by three different bare-text matchers.
 *
 * Every interactive control lands in exactly one bucket — PASS (≥24px), FAIL (<24px), or
 * UNRESOLVED (box not resolvable from source) — and UNRESOLVED FAILS. That partition, not the
 * census itself, is the actual fix: the old guard could not tell "checked and it's fine" from
 * "couldn't see it", and reported both as green.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FLOOR_PX, runCensus, stylesheetsUnderApp } from './touch-target-geometry';
import baseline from './touch-target-baseline.json';

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = resolve(here, '..', 'src');
const appRoot = resolve(here, '..', 'src', 'app');
const globalsCssPath = resolve(appRoot, 'globals.css');
const actionLinkPath = resolve(srcRoot, 'components', 'action-link.ts');

// Pins by CONTENT, not by line number — T-348 S2's new `PageDescription` import shifted every
// line below it in `customers/page.tsx` by one, and a bare line pin drifts on the next unrelated
// edit too. `distinguishing` is a string unique to the one opening tag's own attributes, found
// within `lookahead` lines of the tag so a multi-line opening element still resolves to the tag's
// OWN first line — the same line `runCensus()` reports via `node.getStart()`.
function lineOfOpeningTag(filePath: string, tagNeedle: string, distinguishing: string, lookahead = 4): number {
  const lines = readFileSync(filePath, 'utf8').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const openingLine = lines[i];
    if (openingLine === undefined || !openingLine.includes(tagNeedle)) continue;
    for (let j = i; j <= i + lookahead && j < lines.length; j++) {
      const line = lines[j];
      if (line !== undefined && line.includes(distinguishing)) return i + 1;
    }
  }
  throw new Error(`no ${tagNeedle} element containing "${distinguishing}" found in ${filePath}`);
}

const TARGET_FILES = [
  'app/admin/stores/[id]/page.tsx',
  'app/customers/[customerId]/page.tsx',
  'app/settings/expense-categories/page.tsx',
  'app/cutover/count/page.tsx',
  'app/cutover/opening/page.tsx',
  'app/settings/sales-channels/page.tsx',
  'app/staff/[employmentId]/credentials/page.tsx',
];

const { files, results } = runCensus(srcRoot, globalsCssPath);
const failResults = results.filter((r) => r.status === 'fail');
const unresolvedResults = results.filter((r) => r.status === 'unresolved');

describe('ACTION_LINK sweep — DEF-239 / T-249 (unchanged invariants)', () => {
  it('non-zero control: the walk actually scans a real number of files', () => {
    // Printed first so a broken walk (wrong root, wrong extension) cannot report "0 hits" and
    // look identical to a correctly-fixed tree.
    expect(files.length).toBeGreaterThan(100);
  });

  it('each target file uses ACTION_LINK', () => {
    // §6.7: TARGET_FILES stays exactly as it is — DEF-270 records that dropping a page from it
    // would have a UI task quietly weakening a guard, judged strictly worse than the bundling it
    // avoided.
    for (const rel of TARGET_FILES) {
      const content = readFileSync(resolve(srcRoot, rel), 'utf8');
      expect(content).toContain('ACTION_LINK');
    }
  });

  it('ACTION_LINK stays a real, self-cancelling tap target — a drift guard on the shared constant', () => {
    const content = readFileSync(actionLinkPath, 'utf8');
    expect(content).toContain('py-2');
    expect(content).toMatch(/-my-2\b/);
  });
});

describe('T-262 — the guard\'s own inputs (fail-closed applies to them too, §6.7)', () => {
  it('globals.css is the only stylesheet under apps/erp — step 2b depends on it', () => {
    // If a second stylesheet ever appears, this must go red LOUDLY rather than let the resolver
    // keep computing geometry against a partial picture of the app's CSS.
    const sheets = stylesheetsUnderApp(appRoot).map((p) => p.replace(/\\/g, '/'));
    expect(sheets).toEqual([globalsCssPath.replace(/\\/g, '/')]);
  });
});

describe('T-262 — geometry model self-check (§6.2 step 4, measured in a real browser at 390×844)', () => {
  it('app/customers/page.tsx <button className="px-2 py-0.5 text-xs …"> models to 22px, under the 24px floor (measured 56×22 exact)', () => {
    const line = lineOfOpeningTag(
      resolve(srcRoot, 'app/customers/page.tsx'),
      '<button',
      'className="rounded border border-neutral-300 px-2 py-0.5 text-xs dark:border-neutral-700"',
    );
    const hit = results.find((r) => r.file === 'app/customers/page.tsx' && r.line === line && r.tag === 'button');
    expect(hit).toBeDefined();
    expect(hit).toMatchObject({ status: 'fail', px: 22 });
  });

  it('app/customers/page.tsx <Link> inheriting text-sm models to 20px, under the 24px floor (measured 196×19 — 1px is inline content-height, not model error)', () => {
    const line = lineOfOpeningTag(
      resolve(srcRoot, 'app/customers/page.tsx'),
      '<Link',
      'href={`/customers/${c.id}`}',
    );
    const hit = results.find((r) => r.file === 'app/customers/page.tsx' && r.line === line && r.tag === 'Link');
    expect(hit).toBeDefined();
    expect(hit).toMatchObject({ status: 'fail', px: 20 });
  });
});

describe('T-262 — the two non-zero controls required by §6.7(b)', () => {
  it('the file walk still sees more than 100 files (non-zero control (a))', () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it('the resolver positively identifies all 8 known ACTION_LINK sites at 32px PASS (non-zero control (b))', () => {
    // A resolver that resolves nothing reports "0 undersized" and is indistinguishable from a
    // clean tree — this is the check that tells the two apart. 5 of these 8 sites use ACTION_LINK
    // inside a template substitution (`` `${ACTION_LINK} ...` ``), which is why className
    // resolution must resolve template substitutions, not just concatenate literal spans.
    const actionLinkSites = results.filter((r) => r.status !== 'unresolved' && r.px === 32);
    expect(actionLinkSites.length).toBeGreaterThanOrEqual(8);
    for (const site of actionLinkSites) {
      expect(site.status).toBe('pass');
    }
  });
});

/**
 * T-262 accepted baseline (orchestrator override of §6.9, recorded in the spec doc): the census
 * ships GREEN against `touch-target-baseline.json` rather than permanently red. §6.4's own ruling —
 * 151 candidates is not 151 defects, ~127 are WCAG-exempt inline links — means a permanent red
 * would teach every other lane sharing this tree to say "that red is expected", which is exactly
 * how a real regression gets waved through (RULES §9's definition of done applies to every lane,
 * not just this one). Shrinking the baseline is T-262 spec §6.4's separately-scoped follow-up.
 *
 * Keyed as a per-file MULTISET of modelled heights / unresolved reasons, not `file:line` — see the
 * `_note` in `touch-target-baseline.json` for why, and the trade-off accepted in exchange (a fix and
 * a new defect at the identical height/reason in the same file could theoretically cancel out;
 * judged an acceptable residual risk, far narrower than a whole-tree total, which is explicitly
 * banned — that would let ANY fix mask ANY new defect anywhere in the tree).
 *
 * Three ways this test goes red, all deliberate:
 *   - a control newly appears that isn't in the baseline for its file/height (or file/reason) —
 *     a regression, or an intentionally-accepted addition that needs the baseline file updated;
 *   - a baseline entry is no longer reproduced — the control this size/reason described is gone,
 *     which usually means it is now COMPLIANT and should be removed from the baseline (do not
 *     "fix" this by deleting the baseline entry without checking why first — the control could
 *     also have been deleted, renamed, or moved to a file that no longer matches);
 *   - the accepted-baseline totals stop matching 151 FAIL / 56 UNRESOLVED — a cheap early signal
 *     before the itemised diff below even runs.
 */
function multisetDiff(baselineItems: readonly (string | number)[], actualItems: readonly (string | number)[]) {
  const remaining = [...baselineItems];
  const extra: (string | number)[] = [];
  for (const item of actualItems) {
    const idx = remaining.indexOf(item);
    if (idx === -1) extra.push(item);
    else remaining.splice(idx, 1);
  }
  return { missing: remaining, extra }; // `remaining` = baseline entries never matched
}

describe('T-262 / DEF-269 — every interactive control matches the accepted baseline', () => {
  // ⭐ 53 → 56, T-283 + T-284 (2026-09-12). THREE controls entered the population, all of them
  //   intentionally-accepted additions (the second of the three red cases named above), none a
  //   regression. T-284 added the two `stockModel` radios on `admin/stores/[id]/page.tsx` — the
  //   first writer that column has ever had (DEF-316). And T-283's capability-grant
  //   multi-select replaced a single `<select>` with a checkbox. All three are `unresolved` for
  //   the same reason the other 37 files are: an intrinsic checkbox/radio box is not resolvable
  //   from source (Ian's ruling, §6.1). ⭐ FAIL is unchanged at 151 — nothing became undersized,
  //   because all three reuse the existing full-width touch-target row idiom rather than a new
  //   control shape.
  // ⭐ 56 → 58, T-334 slice 2 (2026-09-21). TWO controls entered the population — the new
  //   `components/ui/Button.tsx` and `components/ui/Input.tsx` — both intentionally-accepted
  //   additions (the second of the three red cases named above), neither a regression.
  //   ⛔ THEY ARE UNRESOLVABLE BY CONSTRUCTION, NOT BY SLOPPINESS, and the builder proved it
  //   empirically rather than by argument: stripping the className-append made each resolve
  //   cleanly, restoring it put each straight back to `unresolved` with a byte-identical reason.
  //   The cause is structural — `className` is a destructured function PARAMETER, and
  //   `findLocalConst` only ever inspects `ts.VariableStatement`s with an `ts.isIdentifier` name
  //   and a literal initializer, so a parameter binding can never resolve no matter how the
  //   reference is shaped. ⭐ A source scanner that DID resolve a runtime prop to a literal would
  //   be the actual defect. Any component accepting a passthrough `className` for a native
  //   control is therefore permanently in this set: `Tile.tsx`, `PhotoInput.tsx` and
  //   `two-way-picker.tsx` (×2) were already here for the identical reason; these are members
  //   four and five of that category.
  //   ⭐ FAIL is unchanged at 151 — nothing became undersized. Because the sweep cannot measure
  //   these two, the orchestrator measured them BY HAND before accepting, which is the whole
  //   point of adjudicating rather than rubber-stamping: Button is `text-sm` (20px line-height)
  //   + `py-2.5` (10px × 2) + `border` (1px × 2) = 42px; Input is `text-sm` + `py-2` (8px × 2)
  //   + `border` = 38px. Both clear `FLOOR_PX` (24) comfortably, and 38px is exactly the repo's
  //   existing form-control convention. ⚠️ What is lost here is STATIC VERIFIABILITY, not tap
  //   size — and it is lost for every future edit to these two files, which is the real cost.
  //   ⛔ Two bugs found on the way were NOT waved through: `BASE_CLASSES` was a `+`-joined
  //   BinaryExpression (unresolvable — `findLocalConst` does not recurse through `resolveExpr`
  //   for a const's own initializer) and Button's variant lookup was an ElementAccessExpression
  //   outside `resolveExpr`'s known shapes. Both were fixed in the components; only the
  //   genuinely-structural remainder was accepted here.
  it('accepted-baseline totals: 148 FAIL / 49 UNRESOLVED', () => {
    // 62 -> 63 UNRESOLVED, T-386 S4 2026-10-09: the rename "use the suggested code" checkbox on app/items/ItemCodeField.tsx
    // (an intrinsic checkbox box; baselined in touch-target-baseline.json per Ian's §6.1 ruling).
    // 63 -> 66 UNRESOLVED, T-387 S3 2026-10-10. +3: the kit's new native `<select>` (Select.tsx) and `<textarea>` (Textarea.tsx)
    // take a caller className through a template like Input.tsx's (same reason string), and Checkbox.tsx's native
    // `<input type="checkbox">` is the intrinsic checkbox box (Ian's ruling, section 6.1). touch-target-baseline.json gains the
    // three entries. FAIL unmoved at 151: the new boxes are 44px (min-h-11).
    // 151 -> 148 FAIL, 66 -> 49 UNRESOLVED, T-387 S8 2026-10-10: the sweep moved buttons/fields onto the 44px kit.
    // FAIL -3: undersized 20/22px controls in customers, fixed-assets and sales-days became 44px kit controls.
    // UNRESOLVED -17: native checkboxes/selects became kit controls in budgets, inventory/locations, pos-map, items,
    // items/[id], ItemCodeField, store-comparison, trade/returns, setup/SubmitButton and two-way-picker.
    // ⚠️ Not a fall: 7 inline prose links (budgets, expenses/new, inventory/production, inventory/usage, liabilities,
    // money-transfers, owners) now sit inside a kit <Banner>, whose text-sm the census cannot see through a component.
    // They were briefly UNRESOLVED; each got an explicit `text-sm` (visually a no-op, the Banner is text-sm) and is
    // again the same accepted 20px inline-link FAIL it was before, entry restored unchanged.
    expect({ fail: failResults.length, unresolved: unresolvedResults.length }).toEqual({ fail: 148, unresolved: 49 });
  });

  // Audit finding F2 (T-334 slice 3, 2026-09-23, blocking): FAIL and UNRESOLVED are the only
  // buckets asserted above — PASS never was. A candidate that stops being counted AT ALL (not
  // failed, not unresolved, just gone) moves neither number and is invisible to every check in this
  // file. Measured: T-334 slice 3 adopting `<Input>` made native `<input>` in its 5 files go
  // 34 -> 23 while {fail: 151, unresolved: 58} sat unmoved, because the 11 converted call sites
  // landed nowhere — `touch-target-geometry.ts` did not recognise the capitalised tag as a
  // candidate at all (fixed separately, same commit). This is the cheap, whole-population
  // backstop the file's own header describes wanting ("a cheap early signal before the itemised
  // diff below even runs") but never actually had for PASS.
  it('the census TOTAL — every candidate, every bucket — matches what was actually measured', () => {
    // 1037 -> 1041, T-337 (2026-09-24). +4 PASS, FAIL/UNRESOLVED unmoved (both asserted above).
    // Itemised: exactly 4 NEW `<summary>` source occurrences in the new
    // `admin/access-defaults/grid.tsx` — DesktopGrid's scope-level summary and its area-level
    // summary, and MobileSections' new scope-level summary and its new area-level summary, all
    // landing PASS at 28/28/32/32px. MobileSections' per-POSITION summary (44px) is NOT new — it
    // is the same "unchanged" accordion T-337 §3 names, moved here from `page.tsx` by commit 1's
    // extraction; it was already counted before, just under a different file path, so it
    // contributes 0 to the delta. Verified by filtering `runCensus()`'s own results to
    // `file.includes('access-defaults')` and reading every summary candidate's line/px, not by
    // arithmetic alone — named by component here rather than by line number, which moves under
    // the next edit to this file.
    // 1041 -> 1043, T-344/DEF-422 (2026-09-25). +2 PASS, FAIL/UNRESOLVED unmoved (both asserted
    // above). Itemised: `app/findings/page.tsx`'s new "Create the missing month" form (the admin
    // action for a hole missing inside closed books) — the `reason` text input at :312 (38px PASS)
    // and its submit button at :318 (34px PASS). The form's three `type="hidden"` inputs (:309-311)
    // are not interactive controls and the census does not count them. Verified by filtering
    // `runCensus()`'s own results to `file === 'app/findings/page.tsx'` and reading each new
    // candidate's line/px, not by arithmetic alone.
    // 1043 -> 1045, T-345 (2026-09-26). +2 PASS, FAIL/UNRESOLVED unmoved (both asserted above).
    // Itemised: `app/findings/page.tsx`'s new "Scheduled charges missed in closed months" section
    // (`ScheduledChargesMissedSection`) — the `reason` text input at :397 (38px PASS) and its
    // "Book it" submit button at :403 (34px PASS). Same shape and same two pixel values as T-344's
    // own pair immediately above it in the same file (createMissingClosedPeriodAction's form, now
    // at :333/:339 — unchanged, just shifted down by the new imports/section). The form's four
    // `type="hidden"` inputs (:393-396) are not interactive controls and the census does not count
    // them. Verified by filtering `runCensus()`'s own results to `file === 'app/findings/page.tsx'`
    // and reading `git diff HEAD -- apps/erp/src/app/findings/page.tsx` directly, not by arithmetic
    // alone — the file's third pre-existing input/button pair (:258/:263) is `acknowledgeFindingAction`,
    // unrelated to either task, and was already counted before this change.
    // 1045 -> 1048, T-346 S1 (2026-09-26). +3, FAIL/UNRESOLVED unmoved (both asserted above).
    // Itemised, verified against `git diff HEAD -- apps/erp/src/app/admin/stores/` directly (not
    // by arithmetic alone), exactly three new interactive controls and nothing else changed in
    // that diff: `app/admin/stores/page.tsx`'s create-store form gains one `<input type="date"
    // name="openingDate">` (no new button — it shares the form's existing submit); and
    // `app/admin/stores/[id]/page.tsx` gains its own "Opening date" form — a second
    // `<input type="date" name="openingDate">` plus its "Save opening date" submit button. The
    // detail-page form's `type="hidden"` `storeId` input is not an interactive control and the
    // census does not count it. ⛔ Pixel classification (PASS/FAIL/UNRESOLVED per control) held
    // pending the code-review hold on this cycle — re-verify against `runCensus()`'s own filtered
    // results the same way T-344/T-345's entries were, before trusting this number as final.
    // 1048 -> 1054, T-346 S2 (DEF-427) (2026-09-26). +6, FAIL/UNRESOLVED unmoved (both asserted
    // above). Itemised, verified against `git diff HEAD -- apps/erp/src/app/fixed-assets/ apps/erp/src/app/admin/stores/`
    // directly (not by arithmetic alone), exactly six new interactive controls and nothing else:
    // `app/fixed-assets/[id]/page.tsx`'s new "In service" form — the `mode` `<select>`, the
    // "Specific date" `<input type="date" name="inServiceOn">`, the `reason` text input, and its
    // submit button (four); `app/fixed-assets/new/page.tsx`'s new "When it goes into service"
    // section — the `inServiceMode` `<select>` and its own `<input type="date" name="inServiceOn">`
    // (two). Per Ian's ruling §6.1 (T-262), the mode pickers are `<select>` elements, not radios —
    // a native radio/checkbox box is unresolvable-by-construction for the touch-target sweep, which
    // is exactly the 8-UNRESOLVED regression an earlier radio-based draft of this same UI produced
    // before the builder redesigned it; a `<select>` sizes from its own classes like this file's
    // other pickers. The confirm-reversal steps on both the asset page and
    // `app/admin/stores/[id]/page.tsx` add only `type="hidden"` inputs (`confirmedPlan`) and
    // reuse each form's EXISTING submit button (relabelled, not a new element) — the census does
    // not count hidden inputs, and an unchanged button contributes nothing to the delta.
    // 1054 -> 1058, T-350 (DEF-477). +4 PASS, FAIL/UNRESOLVED unmoved (both asserted above).
    // Itemised, verified directly against runCensus()'s own filtered results for
    // `app/channel-settlements/page.tsx` (not by arithmetic alone): the new wired-channel-card
    // Change control — the `<details>`'s `<summary>Change</summary>` at :195 (28px), the
    // `moneyAccountId` `<select>` at :203 (26px), its "Save" submit `<button>` at :217 (26px), and
    // the "Cancel" `<Link>` at :223 (28px). All four PASS; nothing else in that file's census
    // entries moved.
    // 1058 = 151 FAIL + 58 UNRESOLVED + 849 PASS, all measured together via runCensus() (not
    // computed from the other two numbers, so this cannot become circular with them). Corrects
    // this comment's own stale "1054 = ...845" breakdown, left behind when T-350 bumped the
    // assertion below without updating the arithmetic note beside it (T-348 S1 audit).
    // 1058 -> 1059, T-348 S1 (DEF-474). +1 PASS, FAIL/UNRESOLVED unmoved (both asserted above).
    // The ONLY new candidate is `PageDescription.tsx`'s own `<button type="button" ...
    // min-h-11 min-w-11>` (44x44, well above the 24px floor) — its JSX literally exists once, in
    // that one file, which `runCensus()`'s walk of `apps/erp/src` reaches directly. The component's
    // ~102 call sites across `app/**` contribute NOTHING: `<PageDescription>` is a plain custom tag
    // (not native, not `Link`, not an onClick-div, not in `KNOWN_COMPONENT_HEIGHT_PX`, and — per
    // spec item 8 — deliberately never added to `OPAQUE_COMPONENTS`), so every branch in
    // `runCensus()`'s visitor skips it silently, same as `<Page>`/`<PageHeader>` themselves today.
    // 1059 -> 1056, T-358 (DEF-485), 2026-09-29. -3 PASS, FAIL/UNRESOLVED unmoved (both asserted
    // above — confirmed unchanged at 151/58 before this re-pin). `apps/ap/invoices/[id]/page.tsx`'s
    // hand-rolled trio (the `method_1` `<select>`, `amount_1` `<input>` and `moneyAccountId_1`
    // `<select>`) is REPLACED by `<MoneyLines>`, a plain custom tag the census walk does not resolve
    // (same reasoning as `PageDescription` above) — three candidates leave the population outright,
    // they do not move buckets.
    // 1056 -> 1060, T-362 (DEF-495), 2026-09-29. +4 PASS, FAIL/UNRESOLVED unmoved (both asserted
    // above — confirmed unchanged at 151/58 before this re-pin). The new "Payment terms" fieldset's
    // four native controls, all styled through the pages' own `INPUT` constant (`text-sm` + `py-2`
    // + `border` = 38px, the repo's existing form-control convention): `app/ap/page.tsx:119`
    // (`termsMode` `<select>`) and `:125` (`creditTermsDays` `<input>`); `app/ap/suppliers/[id]/
    // page.tsx:152` (`termsMode` `<select>`) and `:163` (`creditTermsDays` `<input>`). Verified by
    // filtering `runCensus()`'s own results to these two files and reading each new candidate's
    // line/px directly, not by arithmetic alone.
    // 1060 -> 1063, T-366 S3 (DEF-380/386), 2026-10-01. +3 PASS, FAIL/UNRESOLVED unmoved (both
    // asserted above — confirmed unchanged at 151/58 before this re-pin). The overage branch of
    // `/remittance`'s variance form, previously a plain sentence with no controls at all, gains
    // three: `app/remittance/page.tsx:259` (`fromMoneyAccountId` `<select>`, "Came into" — R5,
    // shown only when the handover came from more than one account, but a static AST census counts
    // the source element regardless of the runtime condition), `:273` (the `reason` `<input>`,
    // "Note (optional)") and `:275` (the `recognise_income` `<button>`, "Recognise as other
    // income (7350)"). All three are styled through the same `INPUT` constant and amber-button
    // classes the shortage branch's sibling controls already use (38px / 38px / 32px), so all
    // three PASS. Verified by filtering `runCensus()`'s own results to `app/remittance/page.tsx`
    // and reading each new candidate's line/px directly.
    // 1086 -> 1096, T-369 S9 (DEF-557), 2026-10-02. +10 PASS, FAIL/UNRESOLVED unmoved (both asserted
    // above — the baseline test ran green at 151/58 with the new total measured). `/money-transfers`
    // gains the "Settle between stores" panel: `app/money-transfers/page.tsx:207` (the `<summary>`
    // disclosure) plus the nine visible controls of `SettleBetweenStoresForm.tsx` — three `<select>`s
    // (the pair picker, `fromMoneyAccountId`, `toMoneyAccountId`), five `<input>`s (`amountOut`,
    // `amountIn`, `transferDate`, `reference`, `notes`) and one `<button>` (the submit). The hidden
    // `settlementId` input is not a control and is not counted. FAIL and UNRESOLVED did not move, so
    // all ten are PASS (by partition, not per-control pixel reading). Verified by running the census
    // (1096) and by counting the form's elements in source (3 selects + 6 inputs − 1 hidden + 1 button).
    // 1096 -> 1097, T-372 S6 (DEF-513), 2026-10-03. +1 PASS, FAIL/UNRESOLVED unmoved (both asserted above —
    // the baseline test ran green at 151/58 with the new total measured). `/commissary/discrepancies` now
    // offers an OVER row its own disposition `<select>` (`app/commissary/discrepancies/page.tsx:171`: extra
    // dispatch / return / audit) beside the short row's existing one; a static census counts the source
    // element regardless of which branch renders. FAIL and UNRESOLVED did not move, so it is PASS by
    // partition, not per-control pixel reading. Verified by running the census (1097).
    // 1097 -> 1103, T-374 S6 + S7 (DEF-574, DEF-578), 2026-10-04. +6 PASS, FAIL/UNRESOLVED unmoved (both asserted
    // above). `/commissary/discrepancies` gains the branch recount section: the order `ACTION_LINK`, the required
    // note `<input>` and the Return `<button>` (its hidden id/storeId/resolvedOn/disposition inputs are not
    // controls). `/inventory/pos-usage` gains the void-pull form: the reason `<input>` and its `<button>`.
    // `/inventory/usage/[id]` gains the `ACTION_LINK` to POS usage that replaces the Void form for a pull-made
    // record (a static census counts the source element regardless of branch). Verified by running the census
    // (1103) and by reading the six added elements in the diff.
    // 1103 -> 1110, T-375 S1, 2026-10-04. +7 PASS, FAIL/UNRESOLVED unmoved (the 'no control is undersized or unresolved
    // outside the accepted baseline' test stays green). New page `/settings/pos-link` (link form controls); a static
    // census counts the source elements regardless of branch. Verified by running the census (1110).
    // 1110 -> 1120, T-375 S2, 2026-10-05. +10 PASS, FAIL/UNRESOLVED unmoved (the 151/58 totals test and the 'no control is
    // undersized or unresolved outside the accepted baseline' test both stay green). The Tenders section of
    // `/settings/pos-link` (`app/settings/pos-link/page.tsx`); a static census counts the source elements regardless of
    // branch. Verified by running the census (1120).
    // 1120 -> 1122, T-375 S3, 2026-10-05. +2 net, UNRESOLVED 58 -> 57 (FAIL unmoved at 151). The "From POS" checkbox in
    // `SalesDayForm.tsx` is gone (-1, one UNRESOLVED baseline entry removed from touch-target-baseline.json); the new
    // Import from POS button and date input (`sales-days/new/page.tsx`) and the Re-import button
    // (`sales-days/[id]/page.tsx`) are +3 PASS. Verified by running the census (1122).
    // 1122 -> 1125, T-375 S4, 2026-10-05. +3 PASS/UNRESOLVED, FAIL unmoved at 151; UNRESOLVED 57 -> 58. The Platform sales
    // form (`sales-days/[id]/page.tsx`) renders one row per non-remitted channel from a single `.map` template: an amount
    // input, a "no sales" checkbox (+1 UNRESOLVED baseline entry, touch-target-baseline.json) and the Save platform sales
    // button. Verified by running the census (1125).
    // 1125 -> 1130, T-375 S6, 2026-10-05. +5, read from the page source: the "Check POS again" button on the T-210 page
    // (`reports/pos-reconciliation/page.tsx`) and on the day page, and the Post correction form on the day page (the
    // date `<input>`, the reason `<input>` and its submit `<button>`); the hidden inputs are not controls. Nothing else.
    // Verified by running the census (1130).
    // 1130 -> 1137, T-377 S2 + T-378 S1/S3, 2026-10-07. +7, found by running the census and diffing against HEAD~5: the
    // items approve form (`items/page.tsx`) gains the Measured-in `<select>` and three sold-as checkboxes (purchasable,
    // retail, wholesale; +3 UNRESOLVED baseline entries, touch-target-baseline.json); the item detail page
    // (`items/[id]/page.tsx`) gains the Change-unit `<select>` and its submit `<button>`; the POS usage pull page
    // (`inventory/pos-usage/page.tsx`) gains the "Finish this pull" submit `<button>` (T-377 S2). Verified by running the census (1137).
    // 1137 -> 1139, T-379 S3b, 2026-10-07. +2: the `deliveryFee` and `otherFees` inputs on the log-a-bill form (`ap/page.tsx`).
    // 1139 -> 1142, T-382 S3, 2026-10-08. +3, found by running the census: the "Unlink from POS" form on `settings/pos-link/page.tsx`
    // gains the reason `<textarea>`, the confirm `<input type="checkbox">` (+1 UNRESOLVED baseline entry, touch-target-baseline.json)
    // and the "Unlink <store>" submit `<button>`. FAIL unmoved at 151. Verified by running the census (1142).
    // 1142 -> 1145, T-383 S1, 2026-10-08. +3: the rename form on `items/[id]/page.tsx` gains the name and code inputs and its
    // "Rename" submit `<button>` (super-admin only). Verified by running the census (1145).
    // 1145 -> 1148, T-384 S3a (merged 2026-10-08). +3: `components/ui/EditableRecord.tsx` gains its Edit, Save and Cancel
    // `<button>`s (static class literals, so the census resolves them; FAIL 151 / UNRESOLVED 62 unmoved). The S1b-min hidden
    // `version` inputs on `settings/pos-link/page.tsx` are not counted. Verified by running the census (1148).
    // 1148 -> 1147, int-fix 2026-10-08. -1: the item page's "Rename" submit `<button>` is gone; the rename section now uses
    // EditableRecord (its Edit/Save/Cancel are counted once, in `components/forms/EditableRecord.tsx`). FAIL 151 / UNRESOLVED 62 unmoved.
    // Verified by running the census (1147).
    // 1147 -> 1145, T-384 sweep integration 2026-10-09. -2, found by running the census: the sweep (full-width FormGrid/Field,
    // EditableRecord wrapping, "Save"/"Save draft" submit renames) removed two controls net of those EditableRecord adds.
    // FAIL / UNRESOLVED assertions unmoved (they pass). Verified by running the census (1145).
    // 1145 -> 1146, T-384 audit-fix 2026-10-09. +1: a sales day with no saved platform rows renders the open add form's
    // "Save" `<button>` (A6). FAIL 151 / UNRESOLVED 62 unmoved. Verified by running the census (1146).
    // 1146 -> 1148, T-386 S4 2026-10-09. +2: `app/items/ItemCodeField.tsx` adds the super-admin code-override input and the
    // rename "use the suggested code" checkbox (+1 UNRESOLVED baseline entry, touch-target-baseline.json). FAIL unmoved at 151.
    // Verified by running the census (1148).
    // 1148 -> 1149, T-386 audit round 2026-10-09. +1: the super-admin "Use a different code" override input moved out of
    // ItemCodeField onto app/items/page.tsx beside "Add directly" (audit #4). FAIL 151 / UNRESOLVED 63 unmoved. Verified (1149).
    // 1149 -> 1151, T-383 S2a 2026-10-09. +2: the Retire section on `items/[id]/page.tsx` (super-admin only) has two submit
    // `<button>`s, one in the Retire form and one in the Restore form (a static census counts both branches); the hidden
    // `itemId`/`status` inputs are not controls. FAIL / UNRESOLVED assertions unmoved. Verified by running the census (1151).
    // 1151 -> 1152, T-395 S2 2026-10-10. +1 PASS: the "Reopen PIN sign-in" submit `<button>` in the new
    // `app/staff/PinSignInPanel.tsx` (the hidden `storeId` input is not a control). FAIL 151 / UNRESOLVED unmoved, so
    // touch-target-baseline.json needs no entry. Verified by running the census (1152).
    // 1151 -> 1152, T-387 S2 2026-10-10. +1: the new `components/feedback/SubmitButton.tsx` renders one kit `<Button type="submit">`.
    // FAIL / UNRESOLVED assertions unmoved. Verified by running the census (1152).
    // 1152 + 1152 -> 1153 at the merge of T-395 S2 and T-387 S2 (both +1). Verified by running the census.
    // 1152 -> 1156, T-387 S3 2026-10-10. +4: Select.tsx `<select>`, Textarea.tsx `<textarea>`, Checkbox.tsx `<input type="checkbox">`
    // (the 3 UNRESOLVED above) and Banner.tsx's "Go to <field>" `<a>` (assumed a PASS: the builder gives it a 24px+ box).
    // FAIL unchanged at 151. If the Banner anchor lands FAIL or UNRESOLVED instead, correct this number and the totals
    // with a measured census, not by guess.
    // 1156 -> 1148, T-387 S8 2026-10-10. -8 net: the sweep removed controls it replaced with kit components; FAIL 151 -> 141, UNRESOLVED 66 -> 56.
    // 1156 + T-395 S2's reopen button -> 1157 at the merge of PR #10 with T-387 S3. Verified by running the census.
    // T-387 S8 merged onto main (1157): measured 1149 (S8's kit swaps net -8 against main's 1157); FAIL 148 / UNRESOLVED 49 unmoved. Verified by running the census.
    expect(results.length).toBe(1149);
  });

  it('no control is undersized or unresolved outside the accepted baseline', () => {
    const baselineFail: Record<string, number[]> = baseline.fail;
    const baselineUnresolved: Record<string, string[]> = baseline.unresolved;
    const failByFile: Record<string, number[]> = {};
    const unresolvedByFile: Record<string, string[]> = {};
    for (const r of failResults) (failByFile[r.file] ??= []).push(r.px);
    for (const r of unresolvedResults) (unresolvedByFile[r.file] ??= []).push(r.reason);

    const report: string[] = [];
    const allFailFiles = new Set([...Object.keys(baselineFail), ...Object.keys(failByFile)]);
    for (const file of allFailFiles) {
      const { missing, extra } = multisetDiff(baselineFail[file] ?? [], failByFile[file] ?? []);
      for (const px of extra) report.push(`NEW FAIL not in baseline: ${file} ${px}px (floor ${FLOOR_PX}px)`);
      for (const px of missing) report.push(`baseline FAIL no longer reproduced (now compliant?): ${file} ${px}px`);
    }
    const allUnresolvedFiles = new Set([...Object.keys(baselineUnresolved), ...Object.keys(unresolvedByFile)]);
    for (const file of allUnresolvedFiles) {
      const { missing, extra } = multisetDiff(baselineUnresolved[file] ?? [], unresolvedByFile[file] ?? []);
      for (const reason of extra) report.push(`NEW UNRESOLVED not in baseline: ${file} — ${reason}`);
      for (const reason of missing) report.push(`baseline UNRESOLVED no longer reproduced (now resolvable?): ${file} — ${reason}`);
    }
    expect(report.sort()).toEqual([]);
  });
});

describe('touch-target-geometry.ts — KNOWN_COMPONENT_HEIGHT_PX is gated on the real import (audit round 2, item 3)', () => {
  it('a LOCAL component named Input (not from @/components/ui) is not counted as a 44px pass', () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), 'touch-target-known-component-'));
    try {
      // A real (but empty) barrel, so a genuine `@/components/ui` import would resolve — proves
      // the negative is about ORIGIN, not about the barrel being unresolvable at all.
      mkdirSync(join(tmpRoot, 'components', 'ui'), { recursive: true });
      writeFileSync(join(tmpRoot, 'components', 'ui', 'index.ts'), 'export function Input() { return null; }\n');

      mkdirSync(join(tmpRoot, 'app', 'fake'), { recursive: true });
      writeFileSync(
        join(tmpRoot, 'app', 'fake', 'page.tsx'),
        // `Input` defined LOCALLY in this file — same name, unrelated component, no import at all.
        'function Input() { return null; }\nexport default function Page() { return <Input />; }\n',
      );

      const { results } = runCensus(tmpRoot, globalsCssPath);
      const hits = results.filter((r) => r.tag === 'Input');
      expect(hits, `local Input should not be in the census at all; got ${JSON.stringify(hits)}`).toEqual([]);
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('control: the SAME shape, imported from the real @/components/ui, IS counted as a 44px pass (t387-q4)', () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), 'touch-target-known-component-control-'));
    try {
      mkdirSync(join(tmpRoot, 'components', 'ui'), { recursive: true });
      writeFileSync(join(tmpRoot, 'components', 'ui', 'index.ts'), 'export function Input() { return null; }\n');

      mkdirSync(join(tmpRoot, 'app', 'fake'), { recursive: true });
      writeFileSync(
        join(tmpRoot, 'app', 'fake', 'page.tsx'),
        "import { Input } from '@/components/ui';\nexport default function Page() { return <Input />; }\n",
      );

      const { results } = runCensus(tmpRoot, globalsCssPath);
      const hits = results.filter((r) => r.tag === 'Input');
      expect(hits).toEqual([{ file: 'app/fake/page.tsx', line: 2, tag: 'Input', status: 'pass', px: 44 }]);
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});
