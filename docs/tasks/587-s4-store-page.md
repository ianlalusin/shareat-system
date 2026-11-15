# T-587 S4 - the store page in plain words

Page: `apps/erp/src/app/admin/stores/[id]/page.tsx`. Navigation, wording and read views only. No migration, no new setting, no new capability.

## What changed
- Details, Opening date and "How this store keeps stock" print their saved values on the page ("Not set" when empty). Editing is still behind the pencil. The locked `EditableRecord` still never prints values (T-448, unchanged).
- Developer wording out: the automatic / business fact tags, the "Recomputed" footnote, "queryable", the "guess wearing the costume" line, "(s)" plurals (`countOf` in `@shareat/core/sentence`), "re-fans", "DEF-059", the screenshot sentence, raw enums in the header line, the double full stop after a manager name.
- "store", not "branch", on this page and in the readiness text (hub and "Branch orders" untouched).
- Readiness is a native `<details>`: closed with "Ready ✓" when all pass, open with "N things need attention" otherwise. 44px summary.
- Menu hours help is one plain sentence with no example times. "Retire hours" is a quiet button (`quiet` prop on `ConfirmDestructive`); its confirm step keeps the danger look and the typed name.
- Close / Reopen this store moved to the very bottom, after both columns.
- Section links are tap-sized (min-h-11): Kitchen stations, Menu hours, Sales channels and settlement wiring, Link to POS store, Cash settings.
- Dates are long form, Manila time (`formatBusinessDayLong`, `{dateStyle:'long'}`), e.g. "February 14, 2022".

## Follow-ups
1. `EditableRecord` could take a `summary` prop so every locked record prints its own values (today each page prints them itself).
2. The stores hub and other screens still say "branch"; BOSS confirms the word separately.

## Remaining 'branch' wording after S4 (for the separate sweep; Ian 15 Nov: 'store' wherever staff read it, keep 'Branch orders' in the commissary)
Commissary screens and status-steps.ts (61 lines) are the commissary's own sense of the word (its branches are internal customers): not part of the sweep unless Ian says so. The other 39 lines, file:line, trimmed:

```
apps/erp/src/app/admin/stores/page.tsx:48: <FormModal trigger="+ Add store" title="Open a branch" size="lg" defaultOpen={Boolean(sp.error)}>
apps/erp/src/app/admin/stores/page.tsx:55: <FormSection title="Branch identity">
apps/erp/src/app/admin/users/[personId]/page.tsx:290: `access.ts`'s position branch only matches/upgrades an existing
apps/erp/src/app/admin/users/[personId]/page.tsx:296: `accessRepo.grantCapability`'s store-grant branch writes `store_id` to
apps/erp/src/app/admin/users/[personId]/page.tsx:315: this branch is, by construction, uncovered — `g.id` names exactly the
apps/erp/src/app/ap/suppliers/page.tsx:64: under each branch, so a fleet-wide vendor became <strong>up to twenty</strong> separate
apps/erp/src/app/expenses/recurring/page.tsx:334: <Field label="Name" hint="What a person calls it — “Lipa branch rent”." rule={RECURRING_TEMPLATE_RULES.name}>
apps/erp/src/app/expenses/recurring/page.tsx:438: <Field label="Name" hint="What a person calls it — “Lipa branch rent”." rule={RECURRING_TEMPLATE_RULES.name}>
apps/erp/src/app/findings/page.tsx:376: but the branch is on `canBook`, not on row count, so the disclosure holds either way. */}
apps/erp/src/app/findings/scorecard/page.tsx:97: <span title="Findings that belong to no single branch">Organisation-wide</span>
apps/erp/src/app/inventory/locations/page.tsx:34: 'This store keeps stock in ONE room (a branch or kiosk) — it may hold exactly one active room besides Receiving.',
apps/erp/src/app/inventory/page.tsx:111: <dt className="text-xs text-muted">In transit (branch orders)</dt>
apps/erp/src/app/settings/page.tsx:81: description="How each branch sells — walk-in and the delivery platforms. Sets whether a channel’s money reaches the till that day or is owed to us until the 
apps/erp/src/app/settings/page.tsx:86: description="Which POS store each branch sells under. A linked branch's sales days come from POS and can't be typed; a branch that isn't linked keeps typing them
apps/erp/src/app/settings/page.tsx:106: description="Who answers for a wasted or refunded order at each branch. With nobody named, a reviewed wastage is created ownerless and the store absorbs it afte
apps/erp/src/app/settings/page.tsx:126: description="Open or close a branch, set how it organises stock, and check what a new store still needs before anyone can trade in it."
apps/erp/src/app/settings/sales-channels/page.tsx:104: How this branch sells: walk-in, and each delivery platform. A channel decides{' '}
apps/erp/src/app/settings/sales-channels/page.tsx:323: The short name and the labels that will let a Foodpanda or Grab payout statement be matched to this branch. They are{' '}
apps/erp/src/app/settings/sales-channels/page.tsx:354: <span className="font-medium">Read wastage emails for this branch</span>
apps/erp/src/app/settings/wastage-monitor/page.tsx:108: <strong>Nobody answers for a wasted order at this branch.</strong> Every reviewed wastage
apps/erp/src/app/staff/hire/page.tsx:112: Use this person: <strong>{p.displayName}</strong>{'branches' in p && ` (works at ${p.branches.join(', ')})`}
apps/erp/src/app/staff/lib.ts:153: ): Promise<{ branches: { storeId: string; storeName: string }[]; hiddenCount: number }> {
apps/erp/src/app/staff/lib.ts:159: const branches = all.filter((b) => held.has(b.storeId));
apps/erp/src/app/staff/lib.ts:169: export async function searchPersonsFor(actor: Actor, query: string): Promise<(PersonRow | { id: string; displayName: string; branches: string[] })[]> {
apps/erp/src/app/staff/[employmentId]/page.tsx:174: PIN per person — it signs them in at every branch they work at, not only{' '}
apps/erp/src/app/staff/[employmentId]/page.tsx:185: branch too. A confirmation after the write would not be a control, and "this affects
apps/erp/src/app/staff/[employmentId]/page.tsx:186: somewhere else" is not something an admin can act on — so it names the branches.
apps/erp/src/app/staff/[employmentId]/page.tsx:188: {!isEnded && otherBranches.branches.length + otherBranches.hiddenCount > 0 && (
apps/erp/src/app/staff/[employmentId]/page.tsx:192: {[detail.storeName, ...otherBranches.branches.map((b) => b.storeName)].join(', ')}
apps/erp/src/app/staff/[employmentId]/page.tsx:194: ` and ${otherBranches.hiddenCount} other branch${otherBranches.hiddenCount === 1 ? '' : 'es'}`}
apps/erp/src/app/trade/orders/actions.ts:124: 'both stores’ books move when the branch confirms what actually arrived.';
apps/erp/src/app/trade/orders/NewOrderForm.tsx:26: internal: 'One of our own stores — an internal transfer. No revenue, no receivable; stock moves at cost and the branch price is the default rate.',
apps/erp/src/app/trade/orders/[id]/page.tsx:317: ? 'The goods leave the commissary: its stock is relieved into in-transit at real FIFO cost. No revenue, no receivable — a branch is not a customer of
apps/erp/src/app/trade/returns/actions.ts:32: reverse_transfer: 'Return recorded. The transfer to the branch is reversed.',
apps/erp/src/components/money/MoneyLines.tsx:58: const optionText = (s: SourceOption, branch = ''): string =>
apps/erp/src/components/money/MoneyLines.tsx:61: : `${labelOf(s)}${branch} · ${s.custodian}  ${peso(availableOf(s))}`;
apps/erp/src/components/money/MoneyLines.tsx:325: <optgroup label="Another branch — needs permission to move that branch's money">
apps/erp/src/lib/account-label.ts:30: '1340': 'Stock in transit between branches',
apps/erp/src/lib/pos-print/header.test.ts:36: it('the receipt header shows the legal name, the address and the TIN with its branch', () => {
```
