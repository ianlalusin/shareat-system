# T-599 — Redesign of the nine longest pages (presentation only)

| Field | Value |
|---|---|
| Planner | spec lane (Opus), 18 Nov 2026 |
| Builder | Claude Sonnet subagents, one per batch (E1, E2, E3), after slice 0 |
| Branch | `t599-long-pages` (one branch; slices are commits on it, in the order in section 6) |
| Risk class | **low**: screens only. No action, field name, hidden input, rule, gate or query changes |
| Numbers reserved | migration: none · DEF: none · bible row: none |

## 1. Goal and contract

The 17 Nov scan (`C:\Users\ianla\webapps\shareat-ui-scan\2026-11-17\`, files `<route>__admin__1280.png` and `__390.png`) shows nine pages that read as a wall: every section is an open card, help
paragraphs open every card, and on a phone the useful part (the next step, the Save button, the prices) is two or three screens down. This task redraws them so the first screen shows what the page
is for, the rest folds away, and nothing behaves differently.

**Contract (every slice).** Same server actions, field `name`s, hidden inputs, `rules`, `typedFor(...)` refills, `requirePageAccess`/capability gates, `ConfirmDestructive` tiers and flash handling.
Only the drawing moves.
- Reuse the kit: `components/ui/DisclosureCard.tsx` (after slice 0), `FormModal` (`components/ui/Dialog.tsx`, has `triggerVariant`, `triggerLabel`, `defaultOpen`), `EditableRecord`
  (`components/forms/EditableRecord.tsx`, has `summary` and `editText`), `HelpTip`, `Badge`, `Banner`, `Button`, `FormGrid`/`Field`/`FormSection`, `SplitWorkspace`, `EmptyState`, `PageHeader` via
  `<Page title description crumb actions>`.
- ⛔ **Never wrap an `EditableRecord` that is alone in a disclosure** (T-571: its locked state is one pencil, so the card opens onto a button). `tests/t571-minimal-disclosure-and-width.test.ts` only
  sees literal `<details>`, so a wrapper component hides the offence from it; the rule still applies. A disclosure may hold an ADD form, a list with its own forms, or a command form.
- ⛔ Never put a `FormModal` inside another `<form>`.
- A disclosure that holds a form opens by itself when that form has a typed refill or a confirm step pending (the `open` prop, slice 0). A refusal must never land inside a closed card.
- One primary (red) button per screen region. Words: plain, "store" never "branch", en-PH long dates.
- Shared component `SalesDayForm.tsx` is also drawn by `/sales-days/new`; slice 7 improves both, on purpose.
- **Read first:** `AGENTS.md`, `docs/RULES.md`, `docs/tasks/590-staff-profile.md` (house style: header, 2/3 + 1/3 columns, forms in modals, danger row last),
  `apps/erp/src/app/staff/[employmentId]/page.tsx:108-320` (the grid), `apps/erp/src/components/ui/README.md`, `docs/GLOSSARY.md` for any word you rename.

## 3. Slice 0 — two shared pieces (do this first, one commit)

**0a. `DisclosureCard` grows four optional props** (`components/ui/DisclosureCard.tsx`, 20 lines today). Every existing caller passes none of them and renders byte-for-byte the same.

```ts
export function DisclosureCard({ id, title, action = 'Add', open, meta, className, children }: {
  readonly id: string;
  readonly title: string;
  /** null: no "+ Add" chip; a chevron that turns when open (a fold, not an add). */
  readonly action?: string | null;
  /** Start open: a typed refill, a pending confirm, an error, or the one thing to act on now. */
  readonly open?: boolean;
  /** Muted text after the title, so a closed card still says what is inside ("27 categories · all mapped"). */
  readonly meta?: ReactNode;
  /** Appended to the outer classes (a tone border, e.g. the next opening-balance step). */
  readonly className?: string;
  readonly children: ReactNode;
})
```
- Keep exactly ONE `<summary>` element with `min-h-11`; `tests/action-link-sweep.test.ts:571` asserts one 44 px summary in this file. Title and meta sit in a `min-w-0 flex-1 flex-wrap` span (`meta`
  is `text-xs text-muted font-normal`); the chevron is the 16 px path `M7 5l5 5-5 5` with `group-open:rotate-90` (add `group` to `<details>`), copied from `admin/stores/[id]/page.tsx:153`.
- Add the four props to `components/ui/README.md` (one line each).
- **Not built:** the stopped E1 builder's `components/Fold.tsx`. It duplicates this card under another name; delete it.

**0b. `SaveBar`** (new `components/ui/SaveBar.tsx`, export from `components/ui/index.ts`): the sticky bottom bar already copied twice. Body is exactly today's markup: `<div className="sticky
bottom-0 z-10 -mx-2 border-t border-surface-border bg-canvas/95 px-2 py-3 backdrop-blur">{children}</div>`. Replace the two copies: `app/sales-days/SalesDayForm.tsx:241-245` and
`app/admin/users/[personId]/page.tsx:537-541`.

**Checks 0:** `tsc`; `tests/action-link-sweep.test.ts`, `tests/t571-minimal-disclosure-and-width.test.ts`, `tests/t337-access-defaults-grid-render.test.ts`, `tests/t450-screen-state.test.ts` pass
with no count change.

## 4. The pages

Sketch key: `[ ]` card · `▸` closed disclosure · `▾` open · `(P)` primary button · `|` column split.

### S1 — `/admin/stores/[id]` (`app/admin/stores/[id]/page.tsx`, 473 lines)

**Wrong today.** Five settings links sit as a button strip above the content (`:127-143`) and wrap to three rows on a phone. The `sectioned` two-column grid (`:145`) leaves a hole under Readiness
while the right column runs six cards. "Opening date" with no date is an always-open add form whose save icon floats in a tall empty card (`:291-366`). Details, opening date and stock model are
three cards for three facts. Screenshot 390: 2,108 px.

```
1280 px
← Stores
ALPHA — Demo Store Alpha            [Active]        (banner: N things stop this store working)
Active · One room · Cash remitted daily
[Readiness ▾ 1 thing needs attention ]  |  [New POS: Off · Change POS mode ]
[About this store                    ]  |  [Store settings  ›Kitchen stations ›Menu hours
  Name / address / phone / TIN / tz ✎ |                   ›Sales channels ›Link to POS ›Cash]
  Opening date   Not opened yet  ▸Set |  [Menu hours (DaypartsSection)      ]
  Stock is kept in  One room        ✎ |
[Close this store  — one line + danger outline button                         ]
```
**Moves.** At 390: one column in this order: header, banner, Readiness, New POS, About this store, Store settings, Menu hours, Close this store. Readiness stays closed when every check passes
(today's rule). Drop `sectioned`; wrap content in `<div className="grid gap-6 lg:grid-cols-3 xl:gap-4">` with a `lg:col-span-2` main column (as `staff/[employmentId]/page.tsx:308-309`).
- Main: Readiness `:146-184` unchanged; then ONE section "About this store" holding, in order, the Details `dl`+`EditableRecord` `:232-277`, the opening-date block `:292-365`, the stock block
  `:379-431`, each as a sub-block divided by `border-t`, keeping each its own `EditableRecord`/form (they post to different actions on purpose: comments at `:280-290` and `:368-377` must stay).
- Opening date with no date (`:345-363`): a row "Opening date — Not opened yet" plus `<DisclosureCard id="opening-date" title="Set the opening date" action="Set" open={Boolean(sp.confirm) ||
  typedFor(sp, STORE_OPENING_DATE, store.id, actor.personId) !== null}>` holding the unchanged `CheckedForm`. The confirm step `:299-319` stays outside any disclosure.
- Side: New POS `:191-229` unchanged; "Store settings" = the five links `:128-142` as a vertical list, each a `min-h-11` row link with a right chevron (reuse `SECTION_LINK` widths or the row-link
  style of the staff Access card), keep `aria-label="Store settings"` on the `<nav>`; then `DaypartsSection` `:434`.
- Close/Reopen `:438-470`: one full-width row, heading + one line + the button on the right (`flex-wrap`).
- **Labels.** "Details" → "About this store". Opening date empty value → "Not opened yet" (never the words "Not set" right after "Opening date": `tests/integration/t587-s4-store-page.test.ts:118`).
  Keep "How this store keeps stock" as the stock sub-heading and "Close this store" (same test, `:143-144`).
- **Must not change.** `updateStoreAction`, `setStoreOpeningDateAction` (+ `confirmedPlan`), `setStoreStockModelAction` (`stockModel` radios), `setStorePosModeAction`/`PosModeForm`,
  `deactivateStoreAction` (`tier="retype"`), `reactivateStoreAction`, all `typedFor(STORE_*)` refills, readiness `<details open={failing > 0}>` markup (t587 `:154-167` match it by regex).
- **Accept.** 390: no sideways scroll; About this store starts within the second screen (≤ 1,300 px from top); every link row ≥ 44 px. 1280: no column hole taller than 120 px. A refused opening date
  reopens with the date filled and the disclosure open.

### S2 — `/staff/hire` (`app/staff/hire/page.tsx`, 186 lines)

**Wrong today.** Two titles ("Hire" `:66` and "Hire someone" `:100`). The description is three lines and is cut behind a chevron on a phone. Status options show raw values ("probationary",
`:139-143`). Position rows are 24 px with an 13 px "primary" radio (`:161-171`). Save is at the very bottom of a long phone form.

```
1280 px and 390 px
← Staff
Hire someone
Search first, so a typo does not make a duplicate.
[Store ▾] [Find a person ____] (Search)
[1 Who is this?   ○ Use: Santos, Maria (works at Bravo)
                  Or a new person: Last | First | Middle (optional)   □ Different person, same name]
[2 The job        Starting status ▾   Start date ▾
                  Positions  □ Cashier ........ ○ Main job   (44 px rows)            ]
═ SaveBar: (P) Save ═══════════════════════════════════════  (sticky on a phone)
```
**Moves.** Header `:62-71`: h1 "Hire someone", description one sentence. Delete the h2 `:100`. Form `:101-183`: two `FormSection`s ("Who is this?" = `:104-134`; "The job" = `:136-178`). Each result
label and each position row `min-h-11`; the "Main job" radio label sits right-aligned in the row. Submit `:180-182` goes inside `<SaveBar>`.

- **Labels.** "Hire" → "Hire someone"; status option text capitalised (`Probationary`, `Regular`, …; values unchanged); "primary" → "Main job"; legend → "Positions" with hint "Tick what they do.
  Mark one as their main job. Leave all blank to hire them as Server, the role with the fewest permissions."
- **Must not change.** `hireAction`, `STAFF_HIRE_RULES`, names `storeId personChoice lastName firstName middleName sameNameConfirmed employmentStatus startedOn positionIds primaryPositionId`, the
  GET `FilterRow` (`store`, `q`). `tests/t438-hire-and-rename-forms.test.ts` pins this form: run it.
- **Keep from E1:** its hire diff (fieldsets, `min-h-11` rows, two-up name grid) is close; replace its hand-made sticky div with `SaveBar` and add the label changes above.
- **Accept.** 390: Save visible at every scroll position; all radios/checkboxes in ≥ 44 px label rows; description not truncated.

### S3 — `/opening-balances` (`app/opening-balances/page.tsx`, 284 lines)

**Wrong today.** Sixteen steps drawn as sixteen open cards, each with its "why" paragraph, so the one step to do now is invisible (1280 capture: 3,478 px). Blocked steps print a full warning banner
each.

```
1280 px and 390 px
Opening balances: 1 January 2027                  [balance hero ₱0.00 — unchanged]
0 of 16 steps done · A 0/4 · B 0/6 · C 0/6
[Next: Clear the delivery-expensing backlog                  (Go to this step)]
[Still needed … (only when gaps exist, unchanged)]
Phase A — in the old system, during December
 ▾ Clear the delivery-expensing backlog   [Do this next]  (open, ink border, full content + confirm form)
 ▸ Final depreciation run                 [To do]
 ▸ Valued stock count — Alpha             [Waiting]  meta: "Waiting for: Clear the delivery…"
 ▸ Export May–December figures            [Done]     meta: "Recorded November 3, 2026"
```
**Moves.** Each `<article>` `:158-277` becomes `<DisclosureCard id={stepAnchor(s)} title={…} action={null} open={s === nextStep} meta={…} className={…}>`; the badge moves into `meta`. Inside,
unchanged order: kind line, why, cannot-verify note, blocked banner, detail, recorded line, links, attest forms. Store name goes in the title ("Valued stock count — Demo Store Alpha"). Next-step
banner above the phases with an in-page anchor link.

- **Keep from E1:** `nextStep`, `stepKey`, `stepAnchor` and the "Next:" banner from its diff; swap its `Fold` for `DisclosureCard`. Badge words: Done (success) · Do this next (progress) · Waiting
  (closed) · To do (closed).
- **Must not change.** `attestStepAction` with `stepCode storeId note`; the C3/C5/B3 links; the rule that a verified step has no form (`:242-243`).
- **Accept.** 1280: whole page ≤ 1,800 px with no step done; the next step is open and on the first screen at 390 after one scroll; every summary ≥ 44 px; `/opening-balances/balance-sheet` link
  still present.

### S4 — `/items/[id]` (`app/items/[id]/page.tsx`, 649 lines)

**Wrong today.** Five one-fact cards (Name and code `:139-174`, Expense category `:177-202`, Other names `:205-239`, Variations `:245-287`, Measured in `:290-318`), each with a dark Edit pill. The
side "Item details" card `:515-523` repeats the header (code, kind, unit). Per-store sellability `:343-453` draws three selects and a Why box per store, open, even when the store just uses the
default. On a phone the prices sit under everything.

```
1280 px
← Items
Demo Pork Belly  [Retired?]
DMPB-001 · Raw material · priced per kg · Wholesale
[About this item                    ] | [Who sells this · Price by month · By supplier
  Name and code   Demo Pork Belly  ✎  |  · Every price paid   (unchanged)                ]
  Expense category  Not set        ✎  |
  Other names   none yet           ✎  |
  Variation of  top-level item     ✎  |
  Measured in   kg  (?) locked        |
[Bought and sold as   ✎  defaults ]   |
  Demo Store Bravo — own answer  ✎    |
  ▸ Demo Store Alpha  uses the default · here: Wholesale
[Retire item — one line + danger outline button                                ]
```
**Moves.** At 390: header, About this item, Bought and sold as, prices, Retire. Item details card gone. Keep `SplitWorkspace` (`:134`). Inside `form`: one `<section>` "About this item" whose five
blocks are today's sections' contents without their own borders, divided by `border-t`; headings become `text-sm` row labels. Each keeps its own `EditableRecord` (`summary` stays; pass `editText`
only if the pencil would sit alone on a line). The Measured-in locked paragraph `:291-300` becomes one line "kg — fixed, it already has records" plus a `HelpTip` holding today's sentence.
Sellability: the org default `EditableRecord` `:335-341` stays visible; a store WITH an override renders as now (its EditableRecord is not hidden); a store WITHOUT one wraps its add form `:412-450`
in `<DisclosureCard id={`sell-${s.storeId}`} title={s.storeName} action="Change" open={typedFor(sp, ITEM_STORE_SELLABILITY, s.storeId, actor.personId) !== null} meta="uses the default · here: …">`.
Delete the "Item details" card `:515-523`; add a `Badge` after the h1 when `item.status !== 'active'`. Move the retire section `:458-509` out of `SplitWorkspace` to a full-width last row.

- **Labels.** "Variations" → "Variation of"; "What it may be bought and sold as" → "Bought and sold as"; "Where a store differs" → "Store exceptions"; "Retire or restore" → "Retire item" (or
  "Restore item" when retired).
- **Must not change.** `renameItemAction`, `setItemExpenseCategoryAction`, `addItemAliasAction`, `removeItemAliasAction`, `setItemVariantOfAction`, `changeItemUnitAction`, `updateItemFlagsAction`,
  `setStoreSellabilityAction`, `clearStoreSellabilityAction` (two forms, comment `:356-362`), `setItemStatusAction`, the `mayApproveItem` gate, every `typedFor(ITEM_*)`.
- **E2 work:** discard. It swapped the two panels and added a "Change this item's settings ↓" jump link; this design removes the cause instead.
- **Accept.** 1280: left column ≤ 1,300 px with two stores using the default. 390: no repeated code/kind/unit block; a refused store override reopens its card with the values typed.

### S5 — `/menu/items/[id]` (`app/menu/items/[id]/page.tsx`, 484 lines)

**Wrong today.** "Add a variant" is an always-open form whose disabled save reads "To save, fix the field marked above" before anyone typed (`:239-252`). "Attach an existing group" is another
always-open form (`:421-449`), plus a red "+ New option group" (`:450`), so the page has two red buttons and two idle forms. Each option group carries an open add-choice form (`:402-418`). One
column, five full-width cards.

```
1280 px
Demo Pork Plate        [Active]               Back to the menu · Prices
À la carte in Demo Mains.
[Variants and stock use        (+ Add variant)] | [Item details  ✎ (EditableRecord as now)]
  Default  [No stock rule]  (P) Set stock rule   | [Prices by store  (as now)            ]
[Option groups   (Add an existing group) (+ New option group)] | [Refills (packages only)]
  Sauce  (+ Add choice)  …                       |
```
**Moves.** At 390: header, Variants, Option groups, Item details, Prices by store, Refills. Keep `sectioned`; add the `lg:grid-cols-3` / `lg:col-span-2` grid. Main: Variants `:153-253`, then
`<OptionGroups>` `:255`. Side: Item details `:110-150`, Prices by store `:287-322`, Refills `:257-284`.
- Add-variant `CheckedForm` `:240-251` → `FormModal trigger="+ Add variant" triggerVariant="secondary" title="Add a variant" size="sm"` in the section header row; drop its h3.
- Attach form `:421-449` → `FormModal trigger="Add an existing group" triggerVariant="secondary"`; "+ New option group" `:450` becomes `triggerVariant="secondary"`. The page's only primary stays
  "Set stock rule" on a variant with no rule.
- Per-group add-choice `CheckedForm` `:402-418` → `FormModal trigger="+ Add choice" triggerVariant="ghost"`.
- Any of these forms with a `typedFor` refill passes `defaultOpen={typed !== null}` (none today; check).
- **Labels.** "Variants and what a sale uses up" → "Variants and stock use"; "Attach an existing group" → "Add an existing group"; "Label (for example Large)" stays.
- **Must not change.** `editItemAction`, `setDepletionRuleAction`, `addVariantAction`, `setPackageRefillsAction`, `linkOptionGroupAction`, `unlinkOptionGroupAction`, `createOptionGroupAction`,
  `editOptionGroupAction`, `addOptionValueAction`, `editOptionValueAction`, `canManage`/`canAddItem` gates, `MENU_*` refills.
- **E2 work:** discard (local `Fold` wrapping the Item details `EditableRecord`, and open-state guessed from `sp.ok` text).
- **Accept.** 1280: no idle form with a disabled save on first load; exactly one red button per column. 390: every modal opens and closes; ≥ 44 px triggers.

### S6 — `/budgets` (`app/budgets/page.tsx`, 357 lines)

**Wrong today.** Forty one-line `<details>` for uncapped categories (`:250-260`), ungrouped, with 24 px summaries; the group name repeats on every row. "Edit or remove" is a 12 px summary (`:206`).

```
1280 px and 390 px
Budgets                                     (filter card + Capped this period — unchanged)
Caps for November 2026
  Cost of goods
    [Meat   ₱4,000 of ₱5,000 · ₱1,000 left ▓▓▓▓░  ▸ Change or remove cap]
Categories with no cap  — A cap of 0.00 means spend nothing.
 ▸ Equipment and assets     1 without a cap
 ▸ Cost of goods            9 without a cap      (opens to a 2-column grid of ▸ category rows)
 ▸ Operating expenses      27 without a cap
```
- **Keep from E2:** its budgets diff whole (`inGroups`, group headings in the caps list, grouped uncapped list, `min-h-11` summaries). One change: the outer group `<details>` becomes
  `<DisclosureCard id={`nocap-${group}`} title={GROUP_LABEL[group] ?? group} action={null} meta={`${rows.length} without a cap`}>`.
- **Labels.** "No cap set" → "Categories with no cap"; "Edit or remove" → "Change or remove cap".
- **Must not change.** `setBudgetAction` via `CapForm`, `removeBudgetAction` (`tier="retype"`), `BUDGET_CAP_RULES`, the `typedFor(BUDGET_CAP_EDIT)` open rule `:205`.
  `tests/integration/t389-s3-budgets-web.test.ts` reads this page.
- **Accept.** 1280 with no caps: page ≤ 900 px; every summary ≥ 44 px; a refused cap edit reopens its card.

### S7 — `/sales-days/[id]/edit` (`app/sales-days/[id]/edit/page.tsx` + `app/sales-days/SalesDayForm.tsx`)

**Wrong today.** Store and date are drawn as grey boxes that look like inputs (`SalesDayForm.tsx:58-77`). Each figure card opens with a two-to-four-line rule paragraph (`:81-84`, `:94-97`,
`:108-111`, `:120-124`, `:135-140`). The channel and wallet `<table>`s (`:141-181`, `:199-218`) turn into phone cards with an initials circle each, so seven wallets take ~1,000 px at 390
(screenshot: 3,851 px).

```
1280 px
← Back to this day
Edit sales day: November 10, 2026
Demo Store Alpha (ALPHA) · the date, store and status stay as they are
[Revenue (?)  Total | Unlimited | À la carte ] | [Sales channels (?)
[Discounts and comps (?)  4 boxes          ] |   Foodpanda  settles later  [____] □ No sales
[Charges (?)  2 boxes                      ] |   Walk-in    reaches till   [____] □ No sales]
[How it was paid (?) Cash | Online | Credit ] | [Which wallet the online money reached (?)
                                              |   Cashier cash  cashier     [____]  … ]
═ SaveBar: (P) Save ═══════════════════════════════════════════════════════
```
**Moves.** At 390: same order, one column; each channel/wallet is ONE row (name + small muted line left, 8rem amount box right; the No sales checkbox in a 44 px label row under it). Save in the
sticky bar. Edit page `:156-163`: description becomes one line. In SalesDayForm `:58-77`, when `dateEditable === false`, draw `storeLabel` and the date as one muted meta line instead of the two grey
boxes; `/new` keeps its date field. Rule paragraphs → `HelpTip` beside each h2 with the same words. Wrap the sections in `<div className="grid gap-4 lg:grid-cols-2">`: left column Revenue → How it
was paid, right column Channels → Wallets → Wallets no longer in use. Replace both `<table>`s with `<ul role="list">` rows (`grid grid-cols-[1fr_8rem] items-center gap-x-3 min-h-11`), keeping every
`Input` and checkbox element, its `name`, `inputMode`, `placeholder` and `defaultValue`; give each input an `aria-label` ("Amount for Foodpanda", "Amount into Cashier cash"), since the column header
is gone. `RuleCheck`s `:183-184` stay right under the channel list.

- **Labels.** "Tender — where the money went" → "How it was paid"; "Where the online money landed" → "Which wallet the online money reached"; "Remittance" column → muted line "reaches the till" /
  "settles later → …" (unchanged words).
- **Must not change.** `editSalesDayAction`, `SALES_DAY_EDIT_RULES`, hidden `storeId salesDayId`, field names `totalSales unliSales alaCarteSales seniorDiscount pwdDiscount otherDiscount comps
  serviceCharge otherCharges cashCollected onlineCollected creditSales channel_<id> nosales_<id> tender_<id>`, `DraftMemory`, the `RuleCheck` ids. Run every test that greps `SalesDayForm` or
  `sales-days/` (t369-s3, t375-s4, t504, t589-b8).
- **E3 work:** none to keep (only a regenerated `apps/erp/AGENTS.md` heading; discard in all three worktrees).
- **Accept.** 390: page ≤ 2,300 px for 2 channels + 7 wallets; Save always visible; no initials circles in this form; no sideways scroll. `/sales-days/new` still renders its date field and saves.

### S8 — `/payroll` (`app/payroll/page.tsx`, 498 lines)

**Wrong today.** On a phone, Store, Period, From, To and Preview stack as five full-width rows (`:115-151`) before any result. The settings line (`:155-198`) is seven fragments that wrap into a
dense paragraph. The two sub-page links are plain underlined text beside the title (`:104-111`).

```
1280 px
Payroll                                   (13th-month pay) (Separations)   ← Page actions, secondary
Pay worked out from attendance. Posting locks the days it paid.
[Store ▾] [Period ▾] (Preview)   ▸ Other dates     (From / To inside, open when no periods exist)
▸ Pay settings for this store   meta: "Shift 9h · overtime ×1.25 · twice a month"
[Preview card — unchanged]
Runs (unchanged) · Pay rates (unchanged)
```
**Moves.** At 390: Store and Period full width, Preview, then the two disclosures, then the preview card. Header `:96-112` → `<Page title="Payroll" description={…} actions={…}>` with the two links
as `min-h-11` secondary-styled links (the `PageHeader` wraps on a phone). In the GET form, From/To `:139-144` go in a `<details>` (or `DisclosureCard action={null}`) titled "Other dates", `open`
when `periodOptions.length === 0` or the dates do not match a period; they stay inside the same `<form method="get">` so the request is identical. Settings `:155-198` → `DisclosureCard
id="pay-settings" title="Pay settings for this store" action={null}`, meta = shift, overtime and period words; inside, the full list as a `dl` and the link "Change pay settings". Move Runs
`:437-493` above Pay rates `:365-434` (runs are what a payroll officer checks after the preview).

- **Labels.** "Edit these settings" → "Change pay settings".
- **Must not change.** GET params `store period start end`; `setPayRateAction` + `PAYROLL_PAY_RATE_RULES` modal; the post/void forms (`:338`, `:476`); `tests/integration/t435-s1-payroll.test.ts`.
- **Accept.** 390: the preview card's top edge is within 800 px of the page top; all controls ≥ 44 px.

### S9 — `/settings/expense-categories` (`app/settings/expense-categories/page.tsx`, 408 lines)

**Wrong today.** 38 rows, each about 84 px: a red "+ Sub-category" under every name (38 primaries), Edit and Retire stacked, plus a "Group" column that repeats the section heading and a "Blocking"
column that is "—" on every row (`:157-344`). "Add a category" hides at the very bottom (`:358-395`).

```
1280 px
Settings / Expense categories                                  (+ Add category) ← Page actions, primary
Which account each kind of spend goes to. A category with no account blocks posting.
[All 38 categories are mapped. Nothing is blocked.]
[Group ▾] [Search ____] (Show)        38 of 38 · 0 with no account
▸ Equipment and assets        1 category · all mapped
▾ Cost of goods               9 categories · 1 with no account   (open: has a problem)
   Category (sub-cats inline)     Posts to                          ✎ name  ✎ account  + Sub-category  Retire
▸ Running costs              27 categories · all mapped
```
**Moves.** At 390: the same disclosures; inside, the existing phone cards, now shorter (no Group/Blocking cells). Each group `<section>` `:152-349` → `DisclosureCard id={`group-${groupName}`}
title={groupWord(groupName)} action={null} meta={…} open={hasUnmapped || groupFilter !== '' || (sp.q ?? '') !== '' || anyTypedInGroup}`, where `anyTypedInGroup` is true when any
`typedFor(EXPENSE_*)` in the group is non-null. Delete the Group column (`:161`, `:226`) and the Blocking column (`:162`, `:227-235`); show blocked drafts as a warning pill after the name ("Holding
up 2 drafts"). "+ Sub-category" `:211` → `triggerVariant="ghost"`. Action cell `:246`: one `flex-nowrap` line at ≥ md. "Add a category" `:358-395` → the page `actions` (keep the `FormModal` and its
`CheckedForm` as is; drop the Card and its h2). Keep the drafts footnote.

- **Labels.** "Blocking" column → pill "Holding up N draft(s)"; "no account" pill stays.
- **Must not change.** `createCategoryAction`, `renameCategoryAction`, `setCategoryAccountAction`, `setCategoryActiveAction` (`tier="confirm"`), `createSubcategoryAction`, `renameSubcategoryAction`,
  `setSubcategoryActiveAction`, `categoryLabel`/`isActive` hidden inputs, the GET filter. `tests/integration/t389-s2-expense-categories-web.test.ts` reads this page.
- **Accept.** 1280 with all mapped: page ≤ 900 px; at most one red button on screen; searching opens matching groups.

## 5. Tests and censuses (every slice)

Re-measure by running, never by guessing. A count that drops is lowered to the reported number with a dated comment in the existing style ("T-599 Sn: …; re-measured by runCensus()"); a count that
rises needs a reason in the commit.

| Guard | File | What moves |
|---|---|---|
| action-link census | `apps/erp/tests/action-link-sweep.test.ts` (`toBe(1686)` at `:568`) | new triggers/rows (+), removed links (−) |
| touch-target baseline | `apps/erp/tests/touch-target-baseline.json` (read by the sweep and `t343-s5-5s-number-boxes`) | remove fails the redesign fixes; add none |
| editable-record / submit-label | `tests/editable-record-baseline.json`, `submit-label-baseline.json` via `t384-s3-lock-and-save-guard.test.ts` | ratchet down only |
| keep-typing | `typed-baseline.json` via `t389-keep-typing-guard.test.ts` | must stay green; a form moved into a modal keeps its refill |
| form width / grid | `form-width-baseline.json`, `form-grid-baseline.json` via `t384-s2-full-width.test.ts` | ratchet |
| live check | `live-check-baseline.json` via `t440-s2-live-check-guard.test.ts` | ratchet |
| t343 ratchets | `t343-s1-action-guard`, `t343-s5-action-guard`, `t343-s6c-screen-labels` | label changes may need the label list |
| destructive census | `t412-destructive-census.test.ts` | unchanged tiers; count must not move |
| lone-edit disclosure | `t571-minimal-disclosure-and-width.test.ts` | must stay green |
| modal frame | `t548-modal-frame.test.ts`, `t589-b7-forms-in-modals.test.ts` | new modals follow the frame |
| PAGES ledger | `docs/ui-review/PAGES.md` via `t589-pages-ledger.test.ts` | add "T-599 Sn" to the row's "fixed in PR" cell |

Plus every test that names the page: `grep -rl "<route or folder>" apps/erp/tests` and run them; fix only assertions that read the old drawing, and say which in the commit. Integration tests run in
CI on the PR. Render each page at 1280 and 390 on the lane port (`docs/SMOKETEST.md`), with the synthetic data, and compare to the 17 Nov screenshots; no console errors, no sideways scroll, modals
open and close.

## 6. Slices and order

| Slice | Commit | Batch |
|---|---|---|
| S0 | DisclosureCard props + SaveBar (+2 callers migrated) | first, alone |
| S1 | `/admin/stores/[id]` | E1 |
| S2 | `/staff/hire` | E1 |
| S3 | `/opening-balances` | E1 |
| S4 | `/items/[id]` | E2 |
| S5 | `/menu/items/[id]` | E2 |
| S6 | `/budgets` | E2 |
| S7 | `/sales-days/[id]/edit` (+ `SalesDayForm.tsx`) | E3 |
| S8 | `/payroll` | E3 |
| S9 | `/settings/expense-categories` | E3 |

- S0 must land before any other slice (S2, S3, S6–S9 use it; S7 also touches the SaveBar caller in SalesDayForm).
- S1–S9 touch nine different page files, so their CODE never conflicts. Their only shared files are the census count line in `action-link-sweep.test.ts`, `touch-target-baseline.json` and `PAGES.md`.
  Run E1, E2, E3 one after another on the one branch (or in three worktrees, then rebase each on the last and re-run the census; never hand-merge a count).
- Partial work: E1 keep hire diff (with SaveBar) and the opening-balances `nextStep` logic, delete `Fold.tsx` and the stores diff; E2 keep the budgets diff, discard items and menu diffs; E3 nothing.
  Discard the `apps/erp/AGENTS.md` heading change everywhere.

## 7. Decisions for Ian

1. **Expense categories: fold the groups?** (a) Groups start closed with a count, and open by themselves when one has a missing account or you search. (b) Everything stays open, just shorter rows.
   **Pick (a)**: the page drops from about 3,800 px to one screen, and the groups that need you still open on their own.
2. **Store page settings links: where?** (a) A "Store settings" list in the right column, one row per link. (b) Keep the button strip at the top. **Pick (a)**: the strip wraps to three rows on a
   phone and pushes Readiness down; a list reads like the staff page's Access card.
3. **Opening balances: how many steps open?** (a) Only the next step open; the rest one line each. (b) Every step you can act on now open. **Pick (a)**: one clear "do this next"; any other step is
   one tap away.

## Builder notes

<!-- the builder writes here -->
