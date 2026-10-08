# T-384: POS link screen — tenders that cannot be lost or overwritten, and full width

**Status:** SPEC 2026-10-08 (Opus planner). Written at HEAD `1301c8a`.
**Model:** Sonnet for every slice, tester first, then builder. S0 is a tester-only browser slice. Any amendment is
written in plan mode (Opus).
**Migration:** **none.** Every change is domain, repo, screen or test. `tenders` already has `updated_at`, the
`tenders_wallet_account_shape_check` CHECK already keeps kind and account consistent, and `shareat_app` already holds
`UPDATE` on `tenders` (0183:255). Nothing new is stored. If S0 or Ian's production read proves a row needs repair, that
is a data fix through the screen (retire / rename / re-add), never a migration. The next free number stays **0188**.
**Defects (PROPOSED — the orchestrator allocates; the register's head is DEF-609):**
- **DEF-610** (🔸, setup can silently go wrong) — the Add-tender form starts Kind at **Cash**, and
  `createTenderAction` turns any kind that is not `"wallet"` into `cash` (`actions.ts:78`). A wallet added without
  switching becomes a cash tender. Kind cannot be changed afterwards (`UpdateTenderInput` has no kind,
  `tenders.ts:29-34`) and the name cannot be reused, because `tenders_store_name_unique` covers retired rows too
  (0183:145). The only way out on screen is to rename an existing row — which looks like "the 4th tender overwrote
  another".
- **DEF-611** (🔸) — the money-account dropdowns list the store's cash drawers (`lib.ts:262`,
  `listMoneyAccounts({storeId})`), which the domain then refuses for a wallet (`tenders.ts:64-69`).
- **DEF-612** (🔸) — every POS-link refusal and confirmation shows only in a banner at the very top of the page, while
  the store's card can be several screens down. `?store=` is carried by every redirect and ignored by the page
  (`page.tsx:16-20`, never read). A refused 4th tender looks like "it didn't save".
- **DEF-613** (⛔ once linked: it decides where money is booked) — a tender's edit form has no stale-write guard. A Save
  writes whatever the form was drawn with, even if the row changed since (another tab, another admin, or a form that
  kept typed values across a redirect). Lost update, silently. S0 decides whether the screen itself can produce it;
  the guard is built either way.
- **DEF-614** (🔸, Ian "again") — 16 `<Page density="form">` wrappers in 13 pages still cap at 48rem, and `table`
  density caps at 80rem (`Page.tsx:61`), leaving 320 px unused at 1920 and more on a wider monitor. T-348's W2 covered
  8 pages only.
- **DEF-615** (🔸) — form fields do not adapt to the screen: 82 form controls in 29 files outside table cells pin a
  fixed width (`w-40`, `w-64`, `max-w-sm`, ...), and no shared form layout exists.
- **DEF-616** (🔸, misdirects the user; Ian, 2026-10-08) — about 30 edit-in-place forms (23 files) draw a saved record
  as live, editable fields with a "Save" button, so a saved row looks exactly like a blank add form. About 13 add forms
  end in "Add …", "Create", "Record …" or "Open branch" instead of "Save". The POS link screen is the case Ian hit:
  the tender rows' "Save" sits next to the "Add tender" box (C6).

## Amendment A0: Ian's lock-and-edit ruling (2026-10-08). It overrides R3 and invariant I5 where they differ.
Ian, verbatim: *"the form design we are using is poor when adding something there is no save button. save buttons
existing must be renamed to edit, lock the fields and only allow edit once edit is clicked then save. implement this
globally so user will not be misdirected."*

**The rule (L-rules), for every form in `apps/erp`:**
- **L1. An existing record is shown locked.**
  - Its fields are truly disabled, inside a `<fieldset disabled>`. A styled look alone is not enough.
  - It has one button, **Edit**.
- **L2. Edit unlocks only that record's fields**, and shows **Save** and **Cancel** in place of Edit.
  - Focus moves to the first field.
  - Cancel puts back the stored values (the form's reset to its rendered defaults), locks the record again, and
    returns focus to Edit.
- **L3. Only one record on a page is in edit mode at a time.**
  - Clicking Edit on record B while record A is open with unsaved changes is refused in place: *"Save or cancel the
    changes you are making first."* The message shows by A's buttons, and A stays open.
  - If A has no changes, A closes (Cancel) and B opens.
- **L4. An add form always ends with a button labelled exactly "Save"** (or "Save draft" where the record is a draft).
  - The section heading keeps saying what is added, for example "Add a tender".
  - "Add tender", "Add category", "Add room", "Add figure", "Add money account", "Create", "Open branch", "Record
    supplier", "Record customer", "Record owner", "Hire" and "Add directly" all become "Save".
  - The existing "Save delivery", "Save mapping", "Save rate", "Save cap", "Save offering", "Save link" and "Save map"
    become plain "Save". The heading says what is saved.
- **L5. Commands are not adds.** A submit that posts money or moves a status keeps its own verb. Examples: Record
  payment, Record transfer, Record the draw, Record contribution / drawing, Post, Approve, Void, Settle, Open count,
  Open shift, Retire, Unlink.
  - The reason: a "Save" that books money for good would misdirect, which is the thing the ruling forbids.
  - These forms sit in the guard's `COMMANDS` list, each with a one-line reason. **Q2** asks Ian to confirm this
    line.
- **L6. The stale-write guard is part of Edit.**
  - The locked form carries the record's `version` (S1a/R1) as rendered.
  - Save sends it, so a record changed since the page was drawn is refused with R1's sentence.
  - After a successful Save the page re-renders. The component is keyed `id:version` (R2), so it comes back locked
    and holding the stored values.
- **L7. Server actions are unchanged.** The component only wraps the `<form action={…}>` the page already has.

**The component: `apps/erp/src/components/ui/EditableRecord.tsx`** (`'use client'`, exported from `ui/index.ts`)
- Props:
  - `action` (the existing server action);
  - `label` (the record's name, for the button's `aria-label`, e.g. "Edit Gcash");
  - `hidden` (the hidden inputs: id, storeId, version);
  - `children` (the fields, written with S2a's `FormGrid` and `Field`);
  - optional `extra` (command buttons shown only in edit mode, each its OWN form rendered after this one, e.g.
    Retire);
  - optional `saveLabel` (default "Save"; only "Save" or "Save draft" are accepted — a type union).
- Renders:
  - `<form action ref>` → `<fieldset disabled={!editing} className="min-w-0">` → children;
  - then a button row: locked shows Edit (`type="button"`); editing shows Save (`type="submit"`) and Cancel
    (`type="button"`, which calls `form.reset()`).
- **One at a time (L3):** a module-level registry (no context provider) — a `Set` of `{id, isDirty(), close()}`. Edit
  asks every other open entry. Dirty means some control's value differs from its `defaultValue` /
  `defaultChecked` / `defaultSelected`.
- **Its behaviour is a pure exported reducer**, `editableRecordReducer(state, event)`, with events
  `edit | cancel | saved | otherDirty`, so it can be unit-tested in the node environment. ⛔ Do not add jsdom (T-348
  §S1). Clicks are tested in the browser smoke.
- With JS off, the record stays locked. This is accepted: the ERP is a JS app. Invariant I5's "no client JS for S1"
  is withdrawn for this one component only.

**S0's production finding (Ian's audit_log read, 2026-10-08) — recorded as Amendment A1's first part:**
- **No tender was overwritten.** `entity='tenders'` shows **3 `create_tender` (all wallets: Gcash, Bank, QR)** and
  **2 `update_tender` whose before equals after** (no-op Saves).
- **There is no `create_tender` for Cash.** The Cash create was REFUSED, and the sentence was not seen. Refusals are
  not audited, so which sentence it was is unknown.
- **"Only allowed to add 3" is H4** (the refusal shows far from Lipa's card) plus an unknown refusal. S1b's smoke
  reproduces a Cash create on a seeded Lipa to name the sentence.
- **H1 and H5 are refuted in production**: no write carried another row's values. **H2 is refuted** (the wallets were
  created as wallets). **H6 is not seen.**
- R1 (the stale-write guard) is still built: it is cheap, and L6 depends on it. DEF-613 is downgraded to 🔸, "no
  stale-write guard; not observed".
- Lipa's four tenders are now in place (Cash, Gcash, Bank, QR), so Monday is no longer a hard deadline for S1b.

## Ian's words (the requirement)
- 2026-10-08, setting up Lipa's tenders before linking Lipa on Monday 12 Oct (Lipa's POS methods: **Bank Transfer,
  Cash, Gcash, QRPH**): *"only allowed to add 3 tenders"*; *"sometimes the 4th tender overwrites others, sometimes it
  doesn't save; some tender already saved is gone when a new 4th tender is added and saved"*; *"the screen again does
  not use the full width"*.
- 2026-10-08, ruling (verbatim, relayed by the orchestrator, who records it as a bible row): *"i want all forms to
  adjust based on screen size and always use full width"*.

## Goal
- Lipa's four POS methods can each be mapped to the right tender and money account in one sitting, and the screen
  shows all four mapped before the link is made.
- No Save can change a tender other than the one it names, and no Save can write values drawn before the row last
  changed.
- A refusal or confirmation appears on the card of the store it is about, and the page returns to that card.
- Every page uses the full content width at every breakpoint, and every form's fields adapt to the screen through one
  shared pattern.

## Research, evaluate, propose (bible row 283; v1 goal, not method)
1. **Verdict.** Build it. S1 is about one day; S2 is a sweep of ~100 files that runs in parallel lanes.
2. **The stated reason, checked at source.** Two investigations reproduced 4 tenders, created and updated, against
   real Postgres with RLS: the domain and DB are clean (writes keyed by id, no cap, no triggers, DELETE revoked). So the
   fault is the screen. Verified at HEAD:
   - `page.tsx:296` Kind `defaultValue="cash"`; `actions.ts:78` maps anything else to cash (DEF-610).
   - `page.tsx:303-309` and `:262-270`: every active account of the store, cash drawers included (DEF-611).
   - `page.tsx:55-56`: the banner is page-level; `sp.store` is never read (DEF-612).
   - `page.tsx:246-287`: each tender is an always-open edit form of uncontrolled `defaultValue` inputs, keyed by
     `x.id`, re-sorted by name after every save (`repo/pos-v1.ts:711`, `orderBy(asc(tenders.name))`). Name, POS name
     and Save sit beside Retire on one line. The "New tender" box looks the same as the rows above it.
   - `actions.ts:99`: a blank POS name on Save clears the alias (`|| null`).
   - `tenders.ts:186-204`: `update_tender` audits before/after name, account and alias; `create_tender`,
     `retire_tender` and `reactivate_tender` are audited too. So Ian's production read of `audit_log`
     (`entity = 'tenders'`) can settle what happened (S0-P).
   - When the store is not linked yet, `storeTenders` does not fetch POS's methods (`lib.ts:266`), so before Monday's
     link Ian has no view of which method maps where.
3. **v1.** v1 has no tender master. Its `paymentMethod` strings are matched at read time (T-375, bible row 270).
   **Goal:** every POS method lands in the right money account. **Its method** (free strings) is not a constraint.
4. **Industry.**
   - Odoo's POS payment methods: a list, with a separate form per method, and journal type (cash/bank) chosen on the
     method. A cash journal is not offered for a bank method.
   - ERPNext's Mode of Payment: one record per method, with a per-company account table and type Cash/Bank/General.
     Accounts are filtered by type.
   - Lost-update protection on an edit form is the standard optimistic-concurrency pattern. ERPNext refuses a save with
     *"Document has been modified after you have opened it"* by comparing `modified`. Rails uses `lock_version`.
   - Responsive forms: Tailwind UI's form layouts use a 1-column grid on phone that widens by breakpoint. CSS
     `repeat(auto-fit, minmax(…, 1fr))` adapts to the CONTAINER width with no breakpoints and no plugin.
5. **Open source.** Nothing to adopt. The patterns above are cited as patterns only.
6. **Effort against use.**
   - S1: about 1 day, and it is needed by Monday (Lipa).
   - S2a: about ½ day. S2b: ~100 files, about 10-15 minutes each, across 6 lanes.
   - Use: every POS-linked store's money mapping, and every form in the app.

## Census, verified at source (HEAD `1301c8a`)
### C1. `density="form"` (16 wrappers, 13 files)
`admin/access-defaults/page.tsx:68` · `admin/stores/[id]/page.tsx:50` (early return) · `cutover/count/page.tsx:30`
(early return), `:47` · `cutover/page.tsx:42` · `settings/attendance/page.tsx:41` (early return) ·
`settings/organization/page.tsx:59` · `settings/pos-link/page.tsx:40` · `settings/sales-channels/page.tsx:63` (early
return), `:87` · `settings/wastage-monitor/page.tsx:58` (early return), `:74` · `staff/hire/page.tsx:43` (early return)
· `staff/[employmentId]/credentials/page.tsx:74` · `staff/[employmentId]/page.tsx:44` · `wastage/[id]/page.tsx:84`.
All under `apps/erp/src/app/`. Totals: 112 `table`, 14 `wide`, 0 `narrow` (sign-in, setup and clock do not use
`<Page>` and are allowlisted in `tests/unit/page-container.test.ts:94-104`).
⚠️ `apps/erp/tests/t348-def440-page-width.test.ts` P2 asserts three of these early returns STAY `form`. Ian's ruling
reverses that, so S2a's tester inverts P2 (dated note).

### C2. `table`'s own cap
`Page.tsx:61` is `max-w-5xl xl:max-w-[80rem]`; `wide` is `max-w-[96rem]`. The content box is the viewport minus 320 px.
At 1920 that is 1600 px against a 1280 cap (`table`). At 2560 it is 2240 px against 1280. **This violates "always use
full width".** Ruling W-R1 removes both caps.

### C3. Form controls with a fixed width (method: `census.py` below; `<input|select|textarea>` className tokens
`w-16..w-96`, `w-[…]`, `max-w-xs..max-w-2xl`, `max-w-[…]`)
107 hits: **25 inside a `<td>`** (table cells, exempt) and **82 outside, in 29 files**:
pos-link 10 · commissary/orders/[id] 8 · payroll 7 · remittance 7 · till 7 · payroll/thirteenth-month 5 · findings 4 ·
attendance 3 · customers/[customerId] 3 · payroll/separations 3 · admin/users/[personId] 2 · settings/attendance 2 ·
settings/expense-categories 2 · settings/organization 2 · settings/sales-channels 2 · trade/orders/[id] 2 · 1 each in
ap/suppliers, budgets, commissary/catalogue, fixed-assets/new, fixed-assets/[id], inventory/counts/[id],
inventory/pos-usage, inventory/returns, inventory/usage/[id], items/[id], prepaid/[id], sales-days/[id],
settings/wastage-monitor. Plus one `<label>` (`sales-days/[id]`).
Tokens: `w-28` ×19, `w-64` ×15, `w-44` ×14, `w-40` ×10, `max-w-sm` ×8, `w-56` ×7, `w-24` ×7, others ≤5.
The 55 `const INPUT =` / 13 `const FIELD =` / 4 `const SELECT =` constants carry no width (33 carry `w-full`).

### C4. Every file with a `<form>`: 104
97 under `app/` and 7 under `components/` (`FilterRow`, `dashboard/RangeForm`, `reports/{Aging,BalanceSheet,Report}Filters`,
`shell/Sidebar`, `shell/TopBar`). By area: inventory 15, settings 6, sales-days 5, expenses 5, customers 5, attendance 5,
ap 5, admin 5, staff 4, commissary 4, trade 3, reports 3, payroll 3, money-transfers 3, fixed-assets 3, cutover 3, 2
each in wastage, sign-in, prepaid, owners, loans, liabilities, items, channel-settlements, cash-requests, and 1 each in
till, statutory-discounts, setup, service-charge, remittance, money-accounts, findings, clock, budgets.
Existing grids are ad hoc: `sm:grid-cols-2` ×66, `sm:grid-cols-3` ×25, `sm:grid-cols-4` ×8, `md:grid-cols-2` ×7,
`lg:grid-cols-3` ×6, and others. There is no shared form-layout component. `components/ui/` has `Button`, `Card` and
`Input` only (T-334).

### C5. Breakpoint facts
- Tailwind is **3.4**, with no container-query plugin.
- The sidebar appears at `md` (768). So at `md` the content box is only ~464 px, and viewport breakpoints mis-describe
  the space the form actually has.
- Next is 16. The App Router runs its own React 19 build (`react@18.3.1` in package.json is not what renders).
  React 19 resets an uncontrolled `<form action={fn}>` after its action completes, which is relevant to hypothesis
  H1.

### C6. Edit-in-place and add forms (A0; method: `census4.py`, a heuristic — S3a's guard makes the authoritative list)
A non-GET `<form>` counts as **edit-in-place** when a control has `defaultValue`/`defaultChecked` bound to a record
field (`x.`, `row.`, `link?.` …) and its submit reads Save/Update/Set/Change. Count: **32 forms in 25 files**. Minus
the two Settle commands (`money-transfers/SettleBetweenStoresForm.tsx:49`, `owners/[id]/page.tsx:126`), that is
**30 forms in 23 files**:
- admin/stores/[id] ×3 (`:141`, `:204`, `:256`); admin/users/[personId] `:118`; ap/invoices/[id] `:219`;
  ap/suppliers/[id] `:86`;
- attendance/[dayId] `:272`; commissary/orders/[id] ×2 (`:448`, `:548`); cutover/count `:118`;
  expenses/[id] `:209`; expenses/recurring `:325`;
- fixed-assets/[id] ×2 (`:184`, `:233`); inventory/counts/[id] `:35`; inventory/locations `:156`;
  inventory/low-stock `:173`;
- items/[id] ×3 (`:120`, `:153`, `:187`); remittance `:594`; sales-days/[id] `:400`;
- settings/attendance `:89`, settings/expense-categories `:175`, settings/organization `:93`, settings/pos-link ×2
  (`:111` link, `:248` tender rows), settings/sales-channels `:280`, settings/wastage-monitor `:147`;
- staff/[employmentId] `:94`.

**Add forms whose submit must become "Save" (L4): 13 forms in 13 files.**
- admin/stores `:115` "Open branch"; ap `:109` "Record supplier"; customers `:169` "Record customer";
  customers/price-lists `:76` "Create"; cutover/opening `:134` "Add figure";
- inventory/locations `:225` "Add room"; items `:225` "Add directly (super-admin)"; money-accounts `:207` "Add money
  account"; owners `:162` "Record owner";
- settings/expense-categories `:211` "Add category"; settings/pos-link `:288` "Add tender"; staff/hire `:101` "Hire";
  commissary/orders/[id] `:175` "Add" (a line on a draft).

**Already "Save …", to normalise: 15 forms (10 become plain "Save", 5 keep "Save draft").**
- budgets `:279`, channel-settlements `:279`, commissary/catalogue ×3 (`:154`, `:235`, `:341`),
  customers/price-lists/[id] `:106`;
- inventory/deliveries/NewDeliveryForm `:10`, inventory/pos-map `:111`, staff `:145`, wastage `:120`;
- the draft forms keep "Save draft": commissary/orders `:203`, expenses/new `:76`, inventory/production `:102`,
  inventory/usage/NewUsageForm `:79`, trade/orders/NewOrderForm `:90`.

**Commands that keep their verb (L5; Q2): about 19 forms.**
- Record expense / payment / transfer / the draw / contribution / drawing / obligation / loan / prepaid item;
- Record (cash-requests, statutory-discounts, clock);
- Open count, Open shift, the till's Record-moment, Create the missing month, Re-issue PIN;
- plus the toggles (On/Off, Retire/Restore, Deactivate, Pause).
- Sign-in, setup and clock are out (Q1).

`census.py` (re-derivation): walk `apps/erp/src/**/*.tsx`. Match
`<(input|select|textarea)\b[^>]*?className=\{?[`"]([^`"]*)` and the tokens above. Classify a hit as inside a cell
when the last `<td` before it is after the last `</td>`.

## Hypotheses S0 must settle (from the two investigations)
| # | Hypothesis | Fixed by |
|---|---|---|
| H1 | An uncontrolled row form shows another tender's (or stale) values after the redirect and re-sort, and a later Save writes them | R1 (guard, regardless) + R2 (remount) |
| H2 | Kind defaults to Cash and Money account to None, so a wallet saved without switching becomes cash | R4, R5 |
| H3 | The account dropdowns offer cash drawers, which a wallet refuses | R6 |
| H4 | Refusals show only at the top, far from Lipa's card, and the page does not return to the card | R7 |
| H5 | Ian edited an existing row's Name/POS name, thinking it was the New-tender box, and renamed it | R3 |
| H6 | Save with a blank POS name clears the alias | R8 |
| H7 (planner, new) | A 4th tender is refused by name: a retired or mis-kinded "Gcash" holds the name (`tenders_store_name_unique` covers retired rows) | R5 (change kind in place) + R7 (the sentence is seen) |

---

## S0: reproduce in a real browser (TESTER only; nothing committed)
**Model:** Sonnet. **Needs:** the gate that is running now to have finished. Port 9008. A throwaway lane DB
(`shareat_t384_s0`, made the house way, migrated to HEAD). Chrome via the Browser pane / Claude-in-Chrome.

**Seed** (through the screens or the house seed helpers, never hand SQL into a shared DB):
- one org and three stores, with Lipa as the THIRD card, so its card is below the fold as in production;
- for Lipa: a cash drawer ("Lipa cash drawer", instrument cash), a bank account ("BPI Lipa") and an e-wallet account
  ("GCash Lipa");
- Lipa NOT linked (as on Saturday).

**Steps.** After each step, record a screenshot of Lipa's card. Record every tender input's live `.value`, read by JS
in the page, against `select id, name, kind, money_account_id, pos_v1_alias, is_active, updated_at from tenders`.
1. Add, in Lipa's order, as a first-time user would: "Bank Transfer" (switch to Wallet + BPI), "Cash" (leave Kind),
   "Gcash" (leave Kind at its default once, then see what Ian would see), "QRPH" (Wallet + BPI).
2. Rename row 2, then Save it. Check that every other row's inputs still equal the DB.
3. Type into row 3 without saving, then Save row 4. Check row 3's inputs and row 4's DB row.
4. Retire one tender, then restore it.
5. Try to add a second "Gcash" (wallet) after the cash one exists. Note where the sentence appears relative to the
   viewport.
6. Save a row with its POS name blank.
7. Repeat 1–3 at 1366 px and 375 px.
8. Dump `select action, entity_id, before, after, created_at from audit_log where entity = 'tenders' order by
   created_at`.

**Output (to the orchestrator, ≤30 lines):** H1–H7, each CONFIRMED / REFUTED with the evidence line (screenshot name,
DOM-vs-DB row, audit row). Plus the exact sentence and position for step 5.

**S0-P: folding Ian's production read.** For each production `audit_log` row with `entity='tenders'`, classify it:
- `create_tender` with `kind=cash` for a wallet-named tender → **H2**;
- `update_tender` whose `before.name` ≠ `after.name` for a tender that was not meant to be renamed → **H5** or **H1**
  (H1 if the `after` values belong to another tender);
- `update_tender` with `after.posV1Alias = null` → **H6**;
- `retire_tender` not intended → a mis-click (R3 moves Retire into the edit disclosure);
- a missing `create_tender` for a tender Ian believes he added → a refusal he did not see (**H4/H7**).

The orchestrator records the verdicts as **Amendment A1**. ⭐ **Its production half is already in (A0): no overwrite, and the Cash create was refused out of sight.** So the browser half shrinks to step 5 (name the Cash refusal sentence) plus the steps S1b's smoke repeats anyway. It may be folded into S1b's smoke. **S0 never blocks S1a.** It blocks S1b only to the extent A1
changes a ruling. R1–R8 are expected to stand whatever S0 finds: R1 is right even if H1 is refuted.

---

## S1: the tender screen (research-evaluate-propose result)
### Rulings
- **R1. Stale-write guard (DEF-613).**
  - `TenderRow` gains `version: string`. It is read as `(extract(epoch from updated_at) * 1000000)::bigint::text`
    (microseconds; not `updated_at::text`, which depends on the session's DateStyle and TimeZone).
  - `UpdateTenderInput` and `setTenderActive`'s input gain an optional `expectedVersion`.
  - `posV1Repo.updateTenderRow` gains an optional `expectedVersion` that adds the same expression `= $v` to its
    `WHERE`, and it returns the number of rows changed.
  - When a version was given and 0 rows changed, the domain refuses with: *"This tender was changed after this page
    was opened. The page now shows what is saved. Check it and save again."* No audit row is written.
  - Optional, so other callers and tests are untouched. The web actions ALWAYS pass it (tested).
- **R2. Remount on change.**
  - Each tender's edit form is `key={`${x.id}:${x.version}`}`, so a row that changed is redrawn from the database,
    never from a previous form state.
  - Every tender form gets `autoComplete="off"`: six forms share field names `name` and `posV1Alias`, which browser
    autofill pairs by name.
- **R3. Add and edit are visibly different things (H5) — superseded in method by A0.**
  - The tenders show in the read-only mapping table (R9). Below it, each active tender is an `<EditableRecord>`
    (A0). It is locked and shows Edit. In edit mode it shows Name, Kind, Money account and POS name, with Save,
    Cancel and, as `extra`, Retire.
  - The store's link form (`page.tsx:111`) is an `<EditableRecord>` too, once the store is linked. An unlinked
    store's link form is an add form, and its submit reads "Save" (L4).
  - Retired tenders sit in a closed `<details>` "Retired tenders (n)", each with Restore.
  - Adding is its own bordered box below, headed "Add a tender", ending in the button "Save" (L4).
- **R4. Kind is chosen, never defaulted (DEF-610, H2).**
  - The Add form's Kind select starts at `value=""` "Choose cash or wallet", and is `required`.
  - `createTenderAction` passes the submitted kind through unchanged. A blank or unknown kind reaches `createTender`,
    which already refuses with *"Choose whether this tender is cash or a wallet."* (`tenders.ts:109`). The action
    no longer decides a kind.
- **R5. Kind can be corrected in place (H2, H7).**
  - `updateTender` accepts an optional `kind`.
  - Cash → wallet needs an account (the existing sentence), checked by `assertStoreAccount`.
  - Wallet → cash clears the account (`moneyAccountId: null`; the shape CHECK holds).
  - The audit's before and after gain `kind`.
  - Nothing references `tenders` (no FK; imported days keep their own `sales_day_tenders` rows), so a kind change
    rewrites no history. It only decides where the next import books, exactly like changing the account, which is
    already allowed.
  - With no JS, the edit form always submits the account select. So `updateTenderAction` forwards `moneyAccountId`
    only when the submitted kind is `wallet`, and it sends `kind: 'cash'` with no account for a cash result. The
    domain then clears the account.
  - On CREATE, Cash with an account chosen stays refused (T-375 RED-3 is unchanged). The Add form's hint says to
    leave the account blank for cash.
- **R6. Only accounts a wallet can use (DEF-611, H3).**
  - `storeTenders().accounts` lists the store's ACTIVE accounts whose `instrument` is not `cash`.
  - The label reads "Money account (wallets only)", with the hint *"Leave it blank for cash. Two wallets may pay into
    the same account — for example Bank Transfer and QRPH into one bank account."* (Sharing is allowed: no uniqueness
    on `tenders.money_account_id`.)
  - When the list is empty: *"{Store} has no bank or e-wallet account yet. Add one under Money accounts first."*,
    with a link to `/money-accounts`.
  - The domain's own check stays: the screen is a convenience, not the rule.
- **R7. Feedback lands on the card (DEF-612, H4).**
  - `redirectWithFlash(path, nav, flash, opts?)` gains `opts.anchor`. It must match `^store-[0-9a-f-]{36}$` (the one
    shape needed; a closed set, like `NAV_SHAPES`). A non-matching anchor is dropped and logged by key name only,
    and is appended as `#anchor` after the query. A `#` in `path` is still refused (`flash.ts:78`).
  - Every pos-link action passes `anchor: store-<storeId>`.
  - Each `StoreCard` gets `id="store-<storeId>"` and `scroll-mt-4`.
  - The page renders `sp.error` / `sp.ok` INSIDE the card whose `storeId === sp.store` (`role="alert"` for an error,
    `role="status"` for ok), directly above the Tenders heading. It uses the top banner only when no card matches.
  - Every ok sentence names the tender: "Gcash added.", "Gcash saved.", "Gcash retired." The name is read back from
    the domain's return or the DB, never trusted from the form.
- **R8. A blank POS name on Save stays "answers to no POS method" (H6).**
  - It is the only way to detach an alias, so it is kept.
  - The field's hint says so, and the mapping table (R9) shows the result at once.
  - With R1 and R2, a blank can only be one the user typed.
  - No domain change.
- **R9. The mapping view: "How POS's payment methods land".** It is a table on each card, built by a pure function
  `tenderMapping(methods | null, tenders, accounts)` in `lib.ts`, matching by `normalizePosV1Alias`.
  - Columns: POS method · Tender · Kind · Money account · Status.
  - Linked and POS answering: one row per POS method. Status is **Mapped** (an active tender answers), or **Not
    mapped — days that use it cannot be imported**. Then one row per active tender that no POS method names: "POS
    doesn't list this name", or "No POS name".
  - Not linked (Lipa until Monday): one row per active tender, plus the note *"POS's payment methods are listed here
    once {Store} is linked. Make each tender's POS name exactly what POS shows."*
  - The existing amber "not mapped yet" box (`page.tsx:239-244`) is replaced by the table's status column. The
    "can't be listed right now" note stays.
- **R10. Every refusal sentence stays the domain's.**
  - The actions add only the ok sentences (R7) and R1's version plumbing.
  - No typed value enters a URL: the flash carries the banners, and the URL carries only `store`, `f` and the anchor
    (T-380).

### S1a: domain, repo, flash (can start NOW, in parallel with S2a)
**BUILDER:**
- `packages/db/src/repo/pos-v1.ts`: `TenderRow.version`, `tenderColumns`, `UpdateTenderPatch.kind`, and
  `updateTenderRow(…, expectedVersion?)`, which returns the row count.
- `packages/domain/src/pos/tenders.ts`: R1, R5, and the audit gains `kind`.
- `apps/erp/src/lib/flash.ts`: R7's `opts.anchor`.

**TESTER:**
- `packages/domain/tests/integration/t384-s1-tenders.test.ts` (new, real Postgres, a lane DB);
- `apps/erp/tests/t384-flash-anchor.test.ts` (new, unit, the `helpers/flash-jar.ts` harness).

**Tests:**
- **D1** (red on HEAD: the second update succeeds). Read version v. `updateTender({expectedVersion: v, name:'A2'})`
  succeeds. The same call again with v → R1's sentence; the row is still 'A2'; there is exactly one `update_tender`
  audit row. Mutant: drop the version clause from the `WHERE` → red.
- **D2** (red on HEAD). `setTenderActive` with a stale version → R1's sentence, still active. Control: the fresh
  version retires.
- **D3** (red on HEAD: kind ignored).
  - Cash → wallet with BPI: kind is wallet, the account is BPI, and the audit `before.kind='cash'`,
    `after.kind='wallet'`.
  - Cash → wallet with no account → *"A wallet tender needs the money account it pays into."*, unchanged.
  - Wallet → cash: the account is null.
  - Mutant: the patch omits `kind` → red.
- **D4** (control, Lipa). Create Bank Transfer (wallet → BPI), Cash (cash), Gcash (wallet → GCash Lipa) and QRPH
  (wallet → BPI). Update each once with its own fresh version. All four rows hold their own values, BPI is shared
  by two, and there are 4 + 4 audit rows.
- **D5** (control). No `expectedVersion` → behaves exactly as HEAD (the existing `t375-s2-tenders` suite stays green
  unchanged).
- **F1** (red on HEAD: no 4th parameter). `anchor: 'store-<uuid>'` → the redirect target is
  `/settings/pos-link?store=<uuid>&f=<n>#store-<uuid>`.
- **F2.** `anchor: 'x"><b'` → no `#` in the target, and one log line naming the key only.
- **F3** (control). A path containing `#` still throws.
- **F4** (control). No `opts` → the target is byte-identical to HEAD's.

### S1b: the screen (after S1a, S2a and S3a; folds Amendment A1)
**BUILDER:**
- `apps/erp/src/app/settings/pos-link/page.tsx`: R2, R3, R4, R6's labels, R7's card banner and id, R9's table. Its
  forms use S2a's `FormGrid`/`Field`, and no control keeps a fixed width.
- `apps/erp/src/app/settings/pos-link/actions.ts`: R1 plumbing (`version` read and passed), R4, R5 (`kind` passed on
  update), R7.
- `apps/erp/src/app/settings/pos-link/lib.ts`: `TenderAdminRow.version`/`kind`, R6's filter, `tenderMapping`.

**TESTER:**
- `apps/erp/tests/integration/t384-s1-pos-link-web.test.ts` (new; render via `renderToStaticMarkup` as in
  `t382-s3-unlink-web.test.ts`, with the fake POS from `t375-s3-fake-pos.test.ts`);
- `apps/erp/tests/t375-s2-tender-action.test.ts` (edit: a blank-kind leg, and the stand-in passes the raw kind;
  dated note);
- `apps/erp/tests/t384-tender-mapping.test.ts` (new, unit, the pure `tenderMapping`).

**Tests:**
- **W1** (red on HEAD: `defaultValue="cash"`, and blank becomes cash).
  - The Add form's `kind` select: its first option is `value=""` and selected, and `required` is present.
  - `createTenderAction` with kind `''` → error flash = *"Choose whether this tender is cash or a wallet."*, and no
    row.
  - Mutant: restore `kind === 'wallet' ? 'wallet' : 'cash'` → red.
- **W2** (red on HEAD). For a store with a cash drawer and BPI, every money-account select lists BPI and never the
  drawer. Mutant: drop the instrument filter → red.
- **W3** (red on HEAD: no version).
  - Each edit form carries a hidden `version` equal to the repo's.
  - `updateTenderAction` with a stale version → error flash = R1's sentence, and the row is unchanged.
  - Mutant: the action omits `expectedVersion` → red.
- **W4** (red on HEAD: the banner is at the top, and there is no `#`).
  - A refused create on store B: the redirect target ends `#store-<B>`.
  - Rendering with `{store: B, error}` puts the alert inside `<section id="store-<B>">`, and there is no top banner.
  - Control: `{error}` with no store → the top banner.
- **W5** (red on HEAD: no table).
  - Linked, with the fake POS listing Bank Transfer, Cash, Gcash and QRPH, plus the four D4 tenders → 4 rows, each
    "Mapped", showing its tender and account (BPI twice).
  - The same with QRPH's alias blank → the QRPH row reads "Not mapped".
  - Not linked → 4 tender rows and the note.
- **W6** (red on HEAD).
  - Each tender renders through `EditableRecord`: a `<fieldset disabled` wraps its fields, and there is an Edit
    button and no visible Save while locked.
  - Its hidden `version` equals the repo's.
  - The add form is under the "Add a tender" heading, its submit reads exactly "Save", and it is not inside any
    `EditableRecord`.
  - Mutant: render the tender form bare → red.
- **W7** (red on HEAD). `updateTenderAction` with kind `wallet` and BPI on a cash tender → ok, and the row is a
  wallet. With kind `cash` on a wallet → the account is cleared.
- **W8** (control, R8). A blank POS name on Save clears the alias, and the row then reads "No POS name".
- **M1–M4** (unit, `tenderMapping`): the alias matches regardless of case and punctuation ("G-Cash" ~ "Gcash"); a
  retired tender never maps; null methods → tender rows only; two wallets on one account both appear.

**Smoke (9008, tester, after the builder).** Re-run S0's steps 1–6 on the built screen (Edit → change → Save; Edit → change → Cancel restores the values; Edit on a second tender while the first has changes is refused in place) at 375, 1366 and 1920, in light
and dark. Each of the four lands with its own sentence on Lipa's card, and the page scrolls to it. A stale Save from a
second tab is refused in words. The mapping table shows four rows. Then link Lipa against the fake POS: all four read
"Mapped".

---

## S2: every page full width, every form adapts (Ian, 2026-10-08)
### Rulings
- **W-R1. One width.**
  - `PageDensity` loses `form`. `table` and `wide` both resolve to no cap (`WIDTH.table = WIDTH.wide = ''`).
  - The type is the first guard: any `density="form"` stops compiling.
  - `wide` is kept as a documented alias, so the 14 report pages are not churned. Its docstring says it is now
    identical to `table` and why. Collapsing the name is optional later work, not a silent orphan.
  - `narrow` is kept for Q1.
  - The arithmetic table in `Page.tsx:21-38` is rewritten.
- **W-R2. One form layout: `components/ui/FormGrid.tsx`** (exported from `components/ui/index.ts`, no
  `'use client'`, like T-334's components).
  - `FormGrid`: `grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(min(100%,14rem),1fr))]`.
    - It adapts to the CONTAINER, not the viewport (C5): 1 column on a phone, and more as the space grows.
    - It needs no breakpoint, and it is right whether the sidebar is open or collapsed.
    - `min(100%,14rem)` stops a 375 px phone from scrolling sideways (DEF-199).
  - `Field({label, hint?, span?: 'wide' | 'full', children})`: a `<label className="block min-w-0">` with the
    house label and hint classes. `span='wide'` adds `sm:col-span-2`. `span='full'` adds `col-span-full` (a
    textarea, a long reason, a line-items table).
  - Controls inside take `w-full`.
  - Planner pick F2 (auto-fit) over F1 (`grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4`): F1 gives 2
    columns at 464 px of content at `md`. **Render before deciding.** S2a's smoke renders both on three forms (the
    tender edit form, `staff/hire`, `settings/organization`) at 375, 1366 and 1920. If F2 looks wrong on screen, the
    orchestrator switches to F1 in Amendment A2 without asking Ian. His ruling already decides the goal.
- **W-R3. What a sweep lane does to a form.**
  - Labelled fields go inside `FormGrid` and `Field`. Every fixed width token (C3) on a control goes.
  - Inline one-control forms (a single select plus a button in a list row) may stay a flex row. The control gets
    `w-full sm:w-auto sm:min-w-48 sm:flex-1` instead of a fixed width.
  - FilterRow fields: the same `sm:min-w-48 sm:flex-1` replacement (`FilterRow` stays flex-wrap; it owns no field
    markup).
  - A control inside a `<td>` keeps its width (a table cell is the measure).
  - A quantity or amount box repeated per line in a non-table line-item grid may keep a width ONLY through the
    guard's `EXEMPT` list, with a one-line reason.
  - Content is unchanged: same fields, same order, same labels, same names. The sweep is layout only. Any field a lane
    thinks is wrong is reported, not fixed.
- **W-R4. The guards** (S2a tester; all static, so no DB is needed). The new file is
  `apps/erp/tests/t384-s2-full-width.test.ts`:
  - **G1.** No `density="form"` anywhere in `apps/erp/src` (backs up the type). It needs a positive-control fixture.
  - **G2.** `Page.tsx`'s `table` and `wide` entries carry no `max-w-`. `narrow` does.
  - **G3.** No form control (`<input|select|textarea|Input`) outside a `<td>` carries a C3 fixed width token, except:
    - entries in `EXEMPT` (file plus a snippet, and a reason; a stale entry fails);
    - the per-file ratchet `apps/erp/tests/form-width-baseline.json`. A file may not exceed its count. A count that
      is now too high fails ("lower the baseline"), so cover cannot linger. The baseline starts at C3's 29 files and
      ends empty.
  - **G4.** Every file with an action `<form>` holding ≥3 labelled controls imports `FormGrid`, or is in the same
    ratchet (`form-grid-baseline.json`, starting at C4's list), or is in `EXEMPT` with a reason.
  - **G5.** Positive controls, literal fixtures: `w-40` on an input is flagged; `w-28` in a `<td>` is not;
    `sm:min-w-48` is not; a stale `EXEMPT` entry is flagged.
  - **G6.** `FormGrid`'s rendered class contains the auto-fit template, and `Field span='full'` renders
    `col-span-full`.
  - ⚠️ T-348 A2's lesson: `apps/erp/tests/touch-target-geometry.ts` resolves font size within one file. If a `<Link>`
    ever sits inside `Field`'s hint, add `Field` to its known-component table red-first, the way `PageDescription`
    was. S2a's tester runs `action-link-sweep` before and after, and records any UNRESOLVED.

### S2a: the container, the component, the guards, the 16 wrappers (first; one lane)
**BUILDER:**
- `apps/erp/src/components/shell/Page.tsx` (W-R1);
- `apps/erp/src/components/ui/FormGrid.tsx` (new) and `components/ui/index.ts`;
- the 13 C1 files, each `density="form"` → `density="table"`, ONE-LINE edits only. This includes
  `settings/pos-link/page.tsx:40`. S2a needs it to compile, so it must land before S1b starts.

**TESTER:**
- `apps/erp/tests/t384-s2-full-width.test.ts` (new);
- `apps/erp/tests/form-width-baseline.json` and `form-grid-baseline.json` (new);
- `apps/erp/tests/t348-def440-page-width.test.ts` (P2 inverted: the early returns use `table`; dated note);
- `tests/unit/page-container.test.ts` (the `:143` message: three widths; comment only).

**Red legs:**
- G1: 16 hits on HEAD.
- G2: `table` carries `max-w-5xl` on HEAD.
- G6: there is no component on HEAD.
- G3/G4 are green at the baseline by construction. G5 proves they can see.

**Smoke:**
- The 13 C1 pages at 375, 1366, 1920 and (if the screen allows) 2560, light and dark.
- No sideways scroll at 375.
- No content left-aligned in a wide empty field.
- `admin/stores/[id]`'s Readiness | Details gutter, judged on screen (T-348 A1).
- The F1/F2 sheets for W-R2.

### S2b: the sweep (after S2a; 6 parallel lanes, one agent per file allowed)
Each lane is BUILDER on its files only. The lane's test is G3/G4 going green for its files at a lower baseline.
**The orchestrator alone edits the two baseline JSONs**, lowering each file's count as each lane's work is merged, so
lanes never collide on shared state. Each lane smokes its routes at 375, 1366 and 1920, light and dark, and reports any
file that needs an `EXEMPT` entry, with the reason. The orchestrator adds it.

| Lane | Files (`apps/erp/src/app/…` unless noted) |
|---|---|
| L1 settings + admin | settings/{attendance,organization,sales-channels,wastage-monitor,expense-categories}/page.tsx, settings/page.tsx if it has a form, admin/** (access-defaults incl. grid.tsx, stores, stores/[id], users/[personId]) |
| L2 people | staff/**, payroll/**, attendance/** (not clock) |
| L3 inventory | inventory/** (15), items/**, wastage/** |
| L4 money | expenses/**, money-accounts, money-transfers/**, cash-requests/**, remittance, till, channel-settlements/**, service-charge, statutory-discounts, budgets, findings |
| L5 AP/AR/trade | ap/**, customers/**, trade/**, commissary/**, owners/**, loans/**, liabilities/**, prepaid/**, fixed-assets/** |
| L6 days + shared | sales-days/**, cutover/**, reports/**, `components/{FilterRow,dashboard/RangeForm,reports/*Filters}.tsx` |

Not swept: `settings/pos-link` (S1b owns it); sign-in, setup and clock (Q1); `components/shell/{Sidebar,TopBar}`
(navigation, not fields).

## S3: lock-and-edit everywhere (A0)
### S3a: the component and its guards (one lane; parallel with S1a and S2a)
**BUILDER:**
- `apps/erp/src/components/ui/EditableRecord.tsx` (new; A0's design);
- `apps/erp/src/components/ui/index.ts` (the export; shared with S2a, so S2a lands first or the lane rebases its one
  line).

**TESTER:**
- `apps/erp/tests/t384-s3-editable-record.test.ts` (new): the reducer and the render;
- `apps/erp/tests/t384-s3-lock-and-save-guard.test.ts` (new): the static guards;
- `apps/erp/tests/editable-record-baseline.json` and `apps/erp/tests/submit-label-baseline.json` (new ratchets,
  seeded from C6; only the orchestrator lowers them during the sweep).

**Tests:**
- **E1** (reducer). `locked` → `edit` → `editing`; `cancel` → `locked`; `saved` → `locked`. `edit` while another
  record is dirty → stays `locked`, with the L3 sentence on the OTHER record. `edit` while another is open and clean
  → that one is told to `cancel`.
- **E2** (render, `renderToStaticMarkup`, node). The initial HTML has a `<fieldset disabled`, an Edit button with
  `aria-label="Edit <label>"`, no `type="submit"`, and every `hidden` input. `extra` is not rendered while locked.
  Mutant: drop `disabled` → red.
- **E3** (type). `saveLabel="Update"` does not compile. This is an `expectTypeOf`/`@ts-expect-error` leg.
- **G7** (lock guard). In `apps/erp/src/app/**`, a non-GET `<form>` that has a hidden `id` or `*Id` input AND a
  control whose `defaultValue`/`defaultChecked` reads a record (`<ident>.` or `<ident>?.`) fails. It passes when it
  is rendered through `<EditableRecord`, or when it is in `EXEMPT` with a reason. Baseline: C6's 30 forms. It ends
  empty.
- **G8** (submit-label guard). Every `type="submit"` label, and every last button in a non-GET form, must be one of:
  - exactly "Save" or "Save draft";
  - a verb in `COMMANDS` (L5; each entry is a verb plus a reason);
  - a toggle pair in `TOGGLES`.
  "Add …", "Create …", "Update" and "Save <noun>" fail. Baseline: C6's 13 + 15 add forms. It ends empty.
- **G9** (positive controls, literal fixtures). A bare record-bound form is flagged. The same form inside
  `<EditableRecord` passes. A submit reading "Add tender" is flagged. "Record payment" passes only while it is in
  `COMMANDS`. A stale `EXEMPT` or `COMMANDS` entry is flagged.

**Smoke (9008).** A scratch page is not committed, so the builder smokes on `settings/organization` in a local working
copy, reverted afterwards. Check L1–L3 and L6: Cancel restores the values; a second Edit is refused while the first
has changes; the Edit → Save → locked round trip works. At 375 and 1366, in light and dark, keyboard only.

### S3b: the sweep, merged with S2b
**One agent per file does both jobs in one pass, in S2b's lanes L1–L6.**
- Width (W-R3).
- Every C6 edit-in-place form goes into `<EditableRecord>`, with its existing action and hidden inputs, plus
  `version` where the record has an S1a-style version. Only tenders have one today. Other records get no version
  field; adding one is N6.
- Add submits are renamed to "Save" / "Save draft" (L4), and the heading is kept or added ("Add a …" / "New …").
- Commands keep their verb, and are reported for `COMMANDS`.

**The lane's test** is G3, G4, G7 and G8 going green for its files at a lower baseline. The orchestrator alone edits
the four baseline JSONs. Content invariant I4 holds: the same field names, actions and order. Only the wrapper and the
button text change.

**Test fallout to expect:** existing render tests that match a button's text ("Add tender", "Record supplier",
"Save changes", …) or expect a live input. Each lane's tester updates those assertions with a dated note; a TESTER
path is named per file at dispatch. The lane does NOT loosen a test to pass.

### Parallel plan (re-sliced for A0)
| Slice | Files (BUILDER) | Shared state | Order |
|---|---|---|---|
| S0 | none (browser) | lane DB `shareat_t384_s0`, 9008 | its production half is done (A0); the browser half folds into S1b's smoke |
| S1a | `repo/pos-v1.ts`, `domain/pos/tenders.ts`, `lib/flash.ts` | a lane DB | now |
| S2a | `Page.tsx`, `ui/FormGrid.tsx`, `ui/index.ts`, 13 C1 pages (one line each) | none | now |
| S3a | `ui/EditableRecord.tsx`, `ui/index.ts` (one export line) | none | now; it lands after S2a, or rebases its one `index.ts` line |
| S1b | `settings/pos-link/{page,actions,lib}.ts(x)` | a lane DB | after S1a + S2a + S3a. **The first page on the new pattern, and the reference for the sweep** |
| S2b+S3b L1–L6 | the lane table in S2b | the 4 baselines (orchestrator only) | after S1b is reviewed (so lanes copy a proven page); parallel with each other |

**`settings/pos-link/page.tsx` is touched twice, in sequence and never at once:** S2a's one-line density flip at `:40`,
then S1b's rewrite on top of it. No S2b or S3b lane opens it. `components/ui/index.ts` is touched by S2a and S3a, one
export line each, so they land in sequence.

## Invariants
- I1. No migration, no data surgery. No money moves. Already-imported days are untouched by a kind or account change.
- I2. `authorize()` stays the first statement in `createTender`, `updateTender` and `setTenderActive`. No new
  capability (`manage_chart_of_accounts` governs, as today).
- I3. Every refusal sentence is the domain's. Sentences carry no ids. No typed value ever enters a URL (T-380).
- I4. The S2 sweep is layout only: the same fields, names, order and labels, and no behaviour change. A diff that
  changes a `name=` attribute is out of scope.
- I5. The only client JS added is `EditableRecord` (A0). No new npm dependency for S2 or S3 (no container-query
  plugin, no jsdom).

## Out of scope
- N1. Fetching POS's methods for a store that is not linked yet (it needs a POS store id). Revisit if Ian wants the
  mapping preview before linking.
- N2. Collapsing `wide` into `table` by name (W-R1 keeps the alias).
- N3. Migrating forms to T-334's `Input` component. That is separate work; the sweep only removes widths.
- N4. Sign-in, setup and clock (Q1).
- N6. A version (stale-write guard) on records other than tenders. L6 applies wherever a record already has one; adding one per table is later work, filed by the orchestrator.
- N5. The register, the bible row for Ian's ruling, the ROADMAP and the board: the orchestrator.

## Done when
- S1a, S1b and S2a: every red leg is shown red on HEAD or against its named mutant before the build, then green.
- S2b+S3b: all four baselines are empty, or `EXEMPT`/`COMMANDS`-only with every entry reasoned (`COMMANDS` per Ian's Q2 answer).
- Typecheck is clean. The `apps/erp` unit suite passes. The integration suites that S1 touches pass on a fresh lane
  DB. `npm run build` passes with the dev server stopped. Touched files are LF.
- Smokes on 9008, with screenshots: S1b's Lipa run, S2a's 13 pages and F1/F2 sheets, and each S2b lane's routes.
- Builders touched only BUILDER paths, and testers only TESTER paths.
- Lipa's four tenders are already in place (A0), so Monday is not a hard gate. S1a + S2a + S3a + S1b come first;
  the sweep lanes may finish after.

## Questions only Ian can answer
**Q1 (low; does not block anything). Sign-in, first-time setup and the clock kiosk show a small centred card. Should
they stay that way?**
- **Why:** your ruling says every form uses the full width. These three are not inside the app's layout (no sidebar),
  and a sign-in box stretched across a 1920 screen is harder to use, not easier.
- **Recommended: keep them as a centred card.** On a phone they already fill the screen. Everything else follows your
  ruling.
- **Alternative:** make them full width too. This is about an hour's work.


**Q2 (medium; it decides the sweep's button text). Some buttons save AND book money or move a record on. Should they
say "Save" too, or keep saying what they do?**
- **Why:** your rule says every add form ends in "Save". But "Record payment", "Record transfer", "Post", "Approve",
  "Open shift" and "Open count" do more than save. A payment booked this way cannot be edited afterwards, only
  reversed.
- **Example:** on a supplier's page, "Record payment" books ₱12,000 out of BPI at once. A button that says "Save"
  could make it look like a draft you can change later.
- **Recommended: keep their own verb** (about 19 buttons). Everything that only stores something you can still
  change says "Save". Those that are not drafts become Edit-locked once saved.
- **Alternative:** every one says "Save". This is about the same work, but a "Save" then sometimes books money for
  good.

## Ruling log
- 2026-10-08, planner: R1–R10, W-R1–W-R4. No migration. DEF-610…615 proposed. H7 found while planning (the name
  index covers retired rows, and kind is immutable).
- 2026-10-08, Ian (via the orchestrator): every page full width, and forms adapt to the screen. S2 widened to every
  form; `table`'s cap is removed (W-R1).
- 2026-10-08, Ian (via the orchestrator): lock-and-edit everywhere, and every add form ends in "Save" (A0, L1–L7).
  `EditableRecord` (S3a) and its guards G7–G9. The sweep (S3b) is merged into S2b's lanes. R3 has been rewritten.
  The production audit is recorded: no overwrite, and the Cash create was refused out of sight. DEF-613 downgraded.
  DEF-616 proposed.

## Amendment A4 — Ian's answers (2026-10-08, orchestrator)
- **Q1 (sign-in, setup, clock): keep them narrow cards.** Ian: "add them to narrow card, stack cards horizontally, mid balance always" — a page with more than one card lays them side by side (wrapping on small screens), and the group is always horizontally centred and balanced. Single-card pages stay one centred card.
- **Q2 = a.** Command buttons that post money or move a status keep their own verb (Verify, Post, Void, Approve, Unlink, Record payment...). Only plain data entry uses Edit / Save.

## Amendment A5 — orchestrator rulings on the labels S3a's tester could not place (2026-10-08)
Rule (Ian Q2 = a): grants/revokes access, posts, moves stock or status, or generates something → COMMAND (keeps its verb). Plain data entry → Edit / Save. Navigation/filter → excluded.
- COMMAND: Apply to every store, Copy (access-defaults: they grant access), Add (admin/users scope: grants access), Build plan (generates a plan), Clear (items/[id]: removes a value as an action), Switch (separations, attendance: status change), Log invoice (creates and posts an AP invoice), Request item (submits a request for approval).
- DATA ENTRY → Edit / Save: Change unit (items/[id]) — it edits the item's unit field.
- NAVIGATION: Set up rooms (a link to another screen), Anchor (customers), Keep "" (items list filter) — if any of these turns out to post data, the sweep lane reports it rather than guessing.
- Confirmed data entry → Save: Rename, Hire's form submit, Set X, Update in-service date, every "Save <noun>", Add/Create/Record on master data (customer, owner, supplier, figure, tender, asset, money account, room, category).

## Amendment A6 — orchestrator rulings during the sweep (2026-10-08/09)
- A form or row with **no saved value yet** (an uncounted item, an empty slot, a store with no override, a day with no
  platform rows) is an **add**: open, submit "Save". Only a form showing an already-saved record goes inside
  `EditableRecord` (locked, Edit). Applied to cutover count, the stock-count sheet, low-stock thresholds, budgets,
  recurring expenses, sales-day platform sales.
- A **dedicated whole-document edit page** (e.g. `/sales-days/[id]/edit`) is not locked again; its submit reads "Save".
- **GET filter/search bars** are never locked; they wrap.
- A **confirm step** in a two-step flow is its own command form ("Confirm change"), never a locked record
  (fixed-assets in-service, store opening date).
- After a **stale-version refusal** the record reopens LOCKED with the stored values (the other user's change);
  only a non-stale refusal reopens in edit mode with the typed values (DEF-617).
- Commands confirmed during the sweep keep their verb: Add directly (super-admin), Apply to every store, Copy, Add
  (access), Log invoice, Anchor, Confirm change, Set up rooms, Build plan, Keep "…" (item merge), Request item, Clear,
  Switch. Data entry relabelled "Save": Hire, Set (pay rate, paid start, payout), Record (statutory discounts).
- Result (2026-10-09): fixed-width controls 89 → 0; record-bound forms 72 → 47 (all commands or exempt);
  off-pattern labels 52 → 0.
