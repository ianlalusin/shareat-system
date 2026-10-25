import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * T-412 S2 (TESTER) - the census of the danger buttons by tier, and the static guards behind it.
 * docs/tasks/412-confirm-destructive-tiers.md "Census" + "Tests / Census" + invariants V6, V9.
 *
 * THE LITERAL MAP below is the spec's census (counted at 76ba502): 60 `variant="danger"` buttons in 47 files, plus the
 * three that are not danger today (cutover/opening "Post the opening balances", payroll/separations "Post separation",
 * inventory/locations "Deactivate") = 63 controls:  P 35 (admin PIN) / R 14 (retype) / W 10 (unguarded workflow) /
 * X 4 (client-only line removers, exempt).
 *
 * WHAT IS ASSERTED, per file, against the real source (apps/erp/src):
 *   - `<ConfirmDestructive tier="admin-pin">` appears exactly as many times as the file has P rows, `tier="retype"` as many as R rows;
 *   - the file's REMAINING `variant="danger"` (the ones outside ConfirmDestructive) number exactly W + X rows - so a P/R danger
 *     button left bare is red, and so is any NEW danger button (V9 / M11: a new one must be classified here first);
 *   - a file not in the map holds neither (no unclassified danger button anywhere in src).
 * and, per P / R row, in the action it submits to (`actionFile`, function `action`):
 *   - P: `verifyAdminApproval(` appears BEFORE every call to the domain mutation (`mutation`), the pin comes from the `adminPin`
 *     field, `capability:` is named, and `storeId` is NOT read from the form (V6 / M8: the store is the record's);
 *   - R: `retypeMatches(` appears before the mutation, takes the typed value from `confirmName`, and its second argument is NOT
 *     read from the form (V8 / M10: the name comes from the database);
 *   - W: no verify and no retype (reject / withdraw / cancel stay unguarded - Ian Q2, recommended option).
 * and globally: no file under apps/erp/src/app reads formData 'confirmed' | 'approved' | 'pinOk' | 'verified' (a forged client flag
 * is never a gate), and the ConfirmDestructive component has the shape the spec fixes.
 *
 * RED TODAY (each case names the first missing thing): no `<ConfirmDestructive>` anywhere, no `verifyAdminApproval(` or
 * `retypeMatches(` in any action, the component file does not exist. GREEN TODAY: the map's own arithmetic, the forged-flag scan
 * (apart from the one allow-listed pre-existing look-alike), and the W rows' "unguarded" legs.
 *
 * MUTANTS: M8 `storeId: str(formData, 'storeId')` in one P action -> its "store from the record" case red; M10 second argument of
 * `retypeMatches` read from the form -> its R case red; M11 add `<Button variant="danger">` anywhere in src -> its file's "danger
 * count" case (or the "unclassified file" case) red; M-c1 delete a `<ConfirmDestructive>` from a P page -> that file red;
 * M-c2 add `formData.get('approved')` anywhere under app/ -> the forged-flag case red.
 */
const SRC = join(__dirname, '..', 'src');

type Tier = 'P' | 'R' | 'W' | 'X';
interface Row {
  file: string; // under apps/erp/src, forward slashes
  tier: Tier;
  label: string;
  /** false for the three controls that are not `variant="danger"` today. */
  danger: boolean;
  /** P / R only: the VISIBLE button text - the exact `label="..."` of its ConfirmDestructive (audit L8: a renamed or unguarded label is caught). */
  visible?: string;
  /** The same, as a pattern, for a conditional row whose wording the spec does not fix. */
  visibleRe?: RegExp;
  /** The control is a CONDITIONAL danger button (`variant={x ? 'danger' : ...}`): audit H1 / H2. */
  conditional?: boolean;
  /** P / R / guarded W only: the server action the form submits to. */
  action?: string;
  actionFile?: string;
  /** The domain / repo call that mutates; every occurrence must come AFTER the guard. A regex source, matched as `NAME(`. */
  mutation?: string;
}

const rows: Row[] = [
  // ---- Tier P (35): an administrator's PIN ----
  { file: 'app/ap/invoices/[id]/page.tsx', tier: 'P', label: 'Void payment', danger: true, visible: 'Void payment', action: 'voidPaymentAction', actionFile: 'app/ap/actions.ts', mutation: 'voidPayment' },
  { file: 'app/ap/invoices/[id]/page.tsx', tier: 'P', label: 'Void invoice', danger: true, visible: 'Void invoice', action: 'voidInvoiceAction', actionFile: 'app/ap/actions.ts', mutation: 'voidInvoice' },
  { file: 'app/attendance/[dayId]/page.tsx', tier: 'P', label: 'Void day', danger: true, visible: 'Void day', action: 'voidDayAction', actionFile: 'app/attendance/[dayId]/actions.ts', mutation: 'decide' },
  { file: 'app/channel-settlements/page.tsx', tier: 'P', label: 'Void settlement', danger: true, visible: 'Void settlement', action: 'voidSettlementAction', actionFile: 'app/channel-settlements/actions.ts', mutation: 'voidChannelSettlement' },
  { file: 'app/commissary/orders/[id]/page.tsx', tier: 'P', label: 'Void dispatch', danger: true, visible: 'Void dispatch', action: 'withdrawOrderAction', actionFile: 'app/commissary/orders/[id]/actions.ts', mutation: 'voidTradeOrder' },
  { file: 'app/customers/[customerId]/page.tsx', tier: 'P', label: 'Write off as bad debt', danger: true, visible: 'Write off as bad debt', action: 'writeOffChargeAction', actionFile: 'app/customers/actions.ts', mutation: 'writeOffCharge' },
  { file: 'app/customers/[customerId]/page.tsx', tier: 'P', label: 'Void charge', danger: true, visible: 'Void charge', action: 'voidChargeAction', actionFile: 'app/customers/actions.ts', mutation: 'voidCharge' },
  // DEF-654: the collection 'void' was a plain <button className={ACTION_LINK}> (not danger), so the census missed it. Tier P.
  { file: 'app/customers/[customerId]/page.tsx', tier: 'P', label: 'Void collection', danger: false, visible: 'Void collection', action: 'voidCollectionAction', actionFile: 'app/customers/actions.ts', mutation: 'voidCollection' },
  { file: 'app/cutover/opening/page.tsx', tier: 'P', label: 'Remove opening figure', danger: true, visible: 'Remove opening figure', action: 'removeOpeningFigureAction', actionFile: 'app/cutover/actions.ts', mutation: 'removeOpeningFigure' },
  { file: 'app/cutover/opening/page.tsx', tier: 'P', label: 'Post the opening balances', danger: false, visible: 'Post the opening balances', action: 'postOpeningBalancesAction', actionFile: 'app/cutover/actions.ts', mutation: 'postOpeningBalances' },
  { file: 'app/expenses/[id]/page.tsx', tier: 'W', label: 'Delete draft', danger: true, action: 'deleteDraftAction', actionFile: 'app/expenses/actions.ts' }, // T-418: a draft delete is a Tier W step (Ian row 348)
  { file: 'app/expenses/[id]/page.tsx', tier: 'P', label: 'Void expense', danger: true, visible: 'Void expense', action: 'voidExpenseAction', actionFile: 'app/expenses/actions.ts', mutation: 'voidExpense' },
  { file: 'app/expenses/recurring/page.tsx', tier: 'W', label: 'Delete template', danger: true, action: 'deleteTemplateAction', actionFile: 'app/expenses/recurring/actions.ts' }, // T-418: a draft delete is a Tier W step (Ian row 348)
  { file: 'app/fixed-assets/[id]/page.tsx', tier: 'P', label: 'Dispose', danger: true, visible: 'Dispose this asset', action: 'disposeAssetAction', actionFile: 'app/fixed-assets/actions.ts', mutation: 'disposeAsset' },
  { file: 'app/inventory/pos-usage/page.tsx', tier: 'P', label: 'Void this pull', danger: true, visible: 'Void this pull', action: 'voidPullAction', actionFile: 'app/inventory/pos-usage/actions.ts', mutation: 'voidPosUsagePull' },
  { file: 'app/inventory/production/[id]/page.tsx', tier: 'P', label: 'Void production', danger: true, visible: 'Void production', action: 'voidProductionAction', actionFile: 'app/inventory/production/actions.ts', mutation: 'voidProduction' },
  { file: 'app/inventory/returns/page.tsx', tier: 'P', label: 'Void supplier return', danger: true, visible: 'Void supplier return', action: 'voidReturnAction', actionFile: 'app/inventory/returns/actions.ts', mutation: 'voidReturn' },
  { file: 'app/inventory/transfers/page.tsx', tier: 'P', label: 'Void transfer', danger: true, visible: 'Void transfer', action: 'voidTransferAction', actionFile: 'app/inventory/transfers/actions.ts', mutation: 'voidTransfer' },
  { file: 'app/inventory/usage/[id]/page.tsx', tier: 'W', label: 'Delete usage draft', danger: true, action: 'deleteUsageDraftAction', actionFile: 'app/inventory/usage/actions.ts' }, // T-418: a draft delete is a Tier W step (Ian row 348)
  { file: 'app/inventory/usage/[id]/page.tsx', tier: 'P', label: 'Void usage', danger: true, visible: 'Void usage', action: 'voidUsageAction', actionFile: 'app/inventory/usage/actions.ts', mutation: 'voidUsage' },
  { file: 'app/liabilities/[id]/page.tsx', tier: 'P', label: 'Reverse liability entry', danger: true, visible: 'Reverse liability entry', action: 'reverseAction', actionFile: 'app/liabilities/actions.ts', mutation: 'reverseLiabilityEntry' },
  { file: 'app/loans/[id]/page.tsx', tier: 'P', label: 'Reverse loan entry', danger: true, visible: 'Reverse loan entry', action: 'reverseEntryAction', actionFile: 'app/loans/actions.ts', mutation: 'reverseLoanEntry' },
  { file: 'app/money-transfers/page.tsx', tier: 'P', label: 'Reverse money transfer', danger: true, visible: 'Reverse money transfer', action: 'voidMoneyTransferAction', actionFile: 'app/money-transfers/actions.ts', mutation: 'voidMoneyTransfer' },
  { file: 'app/payroll/page.tsx', tier: 'P', label: 'Void pay run', danger: true, visible: 'Void pay run', action: 'voidPayRunAction', actionFile: 'app/payroll/actions.ts', mutation: 'voidPayRun' },
  { file: 'app/payroll/separations/page.tsx', tier: 'P', label: 'Void separation', danger: true, visible: 'Void separation', action: 'voidSeparationAction', actionFile: 'app/payroll/separations/actions.ts', mutation: 'voidSeparation' },
  { file: 'app/payroll/separations/page.tsx', tier: 'P', label: 'Post separation', danger: false, visible: 'Post separation', action: 'postSeparationAction', actionFile: 'app/payroll/separations/actions.ts', mutation: 'postSeparation' },
  { file: 'app/payroll/thirteenth-month/page.tsx', tier: 'P', label: 'Void 13th-month run', danger: true, visible: 'Void 13th-month run', action: 'void13thMonthRunAction', actionFile: 'app/payroll/thirteenth-month/actions.ts', mutation: 'void13thMonthRun' },
  { file: 'app/prepaid/[id]/page.tsx', tier: 'P', label: 'Reverse month', danger: true, visible: 'Reverse month', action: 'reverseMonthAction', actionFile: 'app/prepaid/actions.ts', mutation: 'reverseAmortisation' },
  { file: 'app/prepaid/[id]/page.tsx', tier: 'P', label: 'Write it off', danger: true, visible: 'Write it off', action: 'writeOffAction', actionFile: 'app/prepaid/actions.ts', mutation: 'writeOffPrepaidItem' },
  { file: 'app/remittance/page.tsx', tier: 'P', label: 'Reverse remittance', danger: true, visible: 'Reverse remittance', action: 'reverseRemittanceAction', actionFile: 'app/remittance/actions.ts', mutation: 'reverseRemittance' },
  { file: 'app/sales-days/[id]/page.tsx', tier: 'P', label: 'Void sales day', danger: true, visible: 'Void sales day', action: 'voidSalesDayAction', actionFile: 'app/sales-days/actions.ts', mutation: 'voidSalesDay' },
  { file: 'app/staff/[employmentId]/page.tsx', tier: 'P', label: 'End employment', danger: true, visible: 'End employment', action: 'endEmploymentAction', actionFile: 'app/staff/actions.ts', mutation: 'endEmployment' },
  { file: 'app/statutory-discounts/page.tsx', tier: 'P', label: 'Void statutory discount', danger: true, visible: 'Void statutory discount', action: 'voidStatutoryDiscountAction', actionFile: 'app/statutory-discounts/actions.ts', mutation: 'voidStatutoryDiscount' },
  { file: 'app/trade/orders/[id]/page.tsx', tier: 'P', label: 'Void trade order', danger: true, visible: 'Void trade order', action: 'voidOrderAction', actionFile: 'app/trade/orders/actions.ts', mutation: 'voidTradeOrder' },
  { file: 'app/trade/returns/page.tsx', tier: 'P', label: 'Void customer return', danger: true, visible: 'Void customer return', action: 'voidReturnAction', actionFile: 'app/trade/returns/actions.ts', mutation: 'voidCustomerReturn' },
  { file: 'app/wastage/[id]/page.tsx', tier: 'P', label: 'Reverse auto charge', danger: true, visible: 'Reverse auto charge', action: 'reverseAutoChargeAction', actionFile: 'app/wastage/actions.ts', mutation: 'reverseAutoCharge' },
  // ---- Tier R (14): retype the name ----
  { file: 'app/admin/access-defaults/grid.tsx', tier: 'R', label: 'Retire position (row)', danger: true, visible: 'Retire position', action: 'retireStorePositionAction', actionFile: 'app/admin/access-defaults/actions.ts', mutation: 'retireStorePosition' },
  { file: 'app/admin/access-defaults/grid.tsx', tier: 'R', label: 'Retire position (column)', danger: true, visible: 'Retire position', action: 'retireStorePositionAction', actionFile: 'app/admin/access-defaults/actions.ts', mutation: 'retireStorePosition' },
  { file: 'app/admin/users/[personId]/page.tsx', tier: 'R', label: 'Revoke grant', danger: true, visible: 'Revoke grant', action: 'setCapabilityGrantAction', actionFile: 'app/admin/users/actions.ts', mutation: 'revokeGrantById' },
  { file: 'app/admin/users/[personId]/page.tsx', tier: 'R', label: 'Unlink credential', danger: true, visible: 'Unlink sign-in', action: 'unlinkCredentialAction', actionFile: 'app/admin/users/actions.ts', mutation: 'unlinkCredential' },
  { file: 'app/attendance/terminals/page.tsx', tier: 'R', label: 'Revoke terminal', danger: true, visible: 'Revoke terminal', action: 'revokeTerminalAction', actionFile: 'app/attendance/terminals/actions.ts', mutation: 'revokeTerminal' },
  { file: 'app/budgets/page.tsx', tier: 'R', label: 'Remove cap', danger: true, visible: 'Remove cap', action: 'removeBudgetAction', actionFile: 'app/budgets/actions.ts', mutation: 'removeExpenseBudget' },
  { file: 'app/commissary/catalogue/page.tsx', tier: 'R', label: 'Remove mapping', danger: true, visible: 'Remove mapping', action: 'removeMapAction', actionFile: 'app/commissary/catalogue/actions.ts', mutation: 'removeMap' },
  { file: 'app/items/[id]/page.tsx', tier: 'R', label: 'Retire item', danger: true, visible: 'Retire item', action: 'setItemStatusAction', actionFile: 'app/items/actions.ts', mutation: 'setItemStatus' },
  { file: 'app/menu/page.tsx', tier: 'R', label: 'Retire category', danger: true, visible: 'Retire category', action: 'retireCategoryAction', actionFile: 'app/menu/actions.ts', mutation: 'retireMenuCategory' },
  { file: 'app/money-accounts/page.tsx', tier: 'R', label: 'Retire money account', danger: true, visible: 'Retire money account', action: 'retireMoneyAccountAction', actionFile: 'app/money-accounts/actions.ts', mutation: 'retireMoneyAccount' },
  { file: 'app/settings/pos-link/page.tsx', tier: 'R', label: 'Unlink store from POS', danger: true, visible: 'Unlink store from POS', action: 'unlinkStoreFromPosAction', actionFile: 'app/settings/pos-link/actions.ts', mutation: 'unlinkStoreFromPos' },
  { file: 'app/settings/pos-tablet/page.tsx', tier: 'R', label: 'Un-pair tablet', danger: true, visible: 'Un-pair tablet', action: 'unpairPosTabletAction', actionFile: 'app/settings/pos-tablet/actions.ts', mutation: 'unpairPosTablet' }, // T-464
  { file: 'app/settings/pos-link/page.tsx', tier: 'R', label: 'Retire tender', danger: true, visible: 'Retire tender', action: 'setTenderActiveAction', actionFile: 'app/settings/pos-link/actions.ts', mutation: 'setTenderActive' },
  // T-413 (release 2026-10-16): the recipe screen's Retire - Tier R, the recipe's name is retyped and loaded by the action.
  { file: 'app/inventory/production/recipes/[id]/page.tsx', tier: 'R', label: 'Retire recipe', danger: true, visible: 'Retire recipe', action: 'retireRecipeAction', actionFile: 'app/inventory/production/recipes/actions.ts', mutation: 'retireRecipe' },
  // DEF-654: the liability 'Retire' was a plain secondary <Button> (not danger), so the census missed it. Tier R.
  { file: 'app/liabilities/[id]/page.tsx', tier: 'R', label: 'Retire liability', danger: false, visible: 'Retire', action: 'retireAction', actionFile: 'app/liabilities/actions.ts', mutation: 'retireLiability' },
  { file: 'app/staff/[employmentId]/credentials/page.tsx', tier: 'R', label: 'Revoke credential', danger: true, visible: 'Revoke credential', action: 'revokeCredentialAction', actionFile: 'app/staff/[employmentId]/credentials/actions.ts', mutation: 'revokeCredential' },
  { file: 'app/inventory/locations/page.tsx', tier: 'R', label: 'Deactivate room', danger: false, visible: 'Deactivate room', action: 'deactivateLocationAction', actionFile: 'app/inventory/locations/actions.ts', mutation: 'deactivateLocation' },
  // ---- AUDIT ROUND H1 / H2 (orchestrator ruling): the two CONDITIONAL danger buttons `variant={x ? 'danger' : ...}` ----
  { file: 'app/admin/stores/[id]/page.tsx', tier: 'R', label: 'Close this branch', danger: true, conditional: true, visibleRe: /Close this branch|Deactivate/, action: 'deactivateStoreAction', actionFile: 'app/admin/stores/actions.ts', mutation: 'deactivateStore' },
  { file: 'app/admin/users/[personId]/page.tsx', tier: 'R', label: 'In scope - remove', danger: true, conditional: true, visibleRe: /remove/i, action: 'setStoreScopeAction', actionFile: 'app/admin/users/actions.ts', mutation: 'revokeStoreScope' },
  // ---- Tier W (10): workflow steps on unposted documents, unguarded (Ian Q2, recommended) ----
  { file: 'app/attendance/lane/page.tsx', tier: 'W', label: 'Discard event', danger: true, action: 'discardEventAction', actionFile: 'app/attendance/lane/actions.ts' },
  { file: 'app/cash-requests/[id]/page.tsx', tier: 'W', label: 'Withdraw cash request', danger: true, action: 'cancelAction', actionFile: 'app/cash-requests/actions.ts' },
  // ⚠️ SHARED ACTION: withdrawOrderAction serves BOTH "Withdraw/Cancel" (unposted) and "Void dispatch" (posted). Not asserted unguarded.
  { file: 'app/commissary/orders/[id]/page.tsx', tier: 'W', label: 'Withdraw / Cancel order', danger: true },
  { file: 'app/commissary/orders/[id]/page.tsx', tier: 'W', label: 'Reject order', danger: true, action: 'rejectOrderAction', actionFile: 'app/commissary/orders/[id]/actions.ts' },
  { file: 'app/commissary/orders/[id]/page.tsx', tier: 'W', label: 'Remove line', danger: true, action: 'removeLineAction', actionFile: 'app/commissary/orders/[id]/actions.ts' },
  { file: 'app/commissary/orders/[id]/page.tsx', tier: 'W', label: 'Decline line', danger: true, action: 'decideLineAction', actionFile: 'app/commissary/orders/[id]/actions.ts' },
  { file: 'app/inventory/counts/[id]/page.tsx', tier: 'W', label: 'Cancel count', danger: true, action: 'cancelCountAction', actionFile: 'app/inventory/counts/actions.ts' },
  { file: 'app/items/page.tsx', tier: 'W', label: 'Reject item request', danger: true, action: 'rejectItemRequestAction', actionFile: 'app/items/actions.ts' },
  { file: 'app/menu/requests/page.tsx', tier: 'W', label: 'Reject menu request', danger: true, action: 'rejectItemRequestAction', actionFile: 'app/menu/requests/actions.ts' },
  // ⚠️ SHARED ACTION: voidSalesDayAction serves BOTH "Withdraw day" (unverified) and "Void" (verified). Not asserted unguarded.
  { file: 'app/sales-days/[id]/page.tsx', tier: 'W', label: 'Withdraw sales day', danger: true },
  // ---- Exempt (4): client-only "remove a line" in an unsaved form ----
  { file: 'app/inventory/deliveries/NewDeliveryForm.tsx', tier: 'X', label: 'Remove delivery line', danger: true },
  { file: 'app/inventory/usage/NewUsageForm.tsx', tier: 'X', label: 'Remove usage line', danger: true },
  { file: 'app/trade/orders/NewOrderForm.tsx', tier: 'X', label: 'Remove order line', danger: true },
  { file: 'components/money/MoneyLines.tsx', tier: 'X', label: 'Remove money line', danger: true },
];

const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8');
function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
  }
  return out;
}
const rel = (abs: string) => abs.slice(SRC.length + 1).split(String.fromCharCode(92)).join('/');
/** Comments removed, so a guard named only in a comment cannot satisfy a check. */
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
// audit H1 / H2: the literal AND any `variant={ ... 'danger' ... }` expression (a conditional danger button is still one)
const DANGER = /variant=(?:"danger"|\{[^}]*['"]danger['"][^}]*\})/g;
const BS = String.fromCharCode(92); // a literal backslash, built (a typed  in this file would be a backspace)
const count = (s: string, re: RegExp) => (s.match(re) ?? []).length;

/** Every `<ConfirmDestructive ...` opening in the file, with the next 900 characters as its attribute window. */
function confirmWindows(src: string): string[] {
  const parts = src.split('<ConfirmDestructive');
  return parts.slice(1).map((p) => p.slice(0, 900));
}
/**
 * T-440 S1 (A3 / T-S1-16): the form a ConfirmDestructive sits in is a native `<form` OR a `<CheckedForm` (an add form converted to
 * live checks). Looking for the text `<form` only would make every converted form fail "a <form precedes its ConfirmDestructive".
 */
const FORM_END = /<\/(?:form|CheckedForm)>/;
function enclosingForm(src: string, at: number): { start: number; between: string } {
  const start = Math.max(src.lastIndexOf('<form', at), src.lastIndexOf('<CheckedForm', at));
  return { start, between: start < 0 ? '' : src.slice(start, at) };
}
const tierOf = (w: string) => /tier=\{?\s*['"](admin-pin|retype)['"]/.exec(w)?.[1];

function functionBody(src: string, name: string): string | undefined {
  const m = new RegExp('export async function ' + name + '[^A-Za-z0-9_]').exec(src);
  if (!m) return undefined;
  const rest = src.slice(m.index + 10);
  const next = rest.search(/\nexport /);
  return stripComments(next < 0 ? rest : rest.slice(0, next));
}
/** The text of the balanced (...) that opens at `open` (index of the '('). */
function balanced(s: string, open: number): string {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === '(') depth++;
    else if (s[i] === ')' && --depth === 0) return s.slice(open + 1, i);
  }
  return s.slice(open + 1);
}
function topLevelArgs(argText: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  let quote = '';
  for (const ch of argText) {
    if (quote) {
      cur += ch;
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') quote = ch;
    if ('([{'.includes(ch)) depth++;
    if (')]}'.includes(ch)) depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
const FORM_READ = /formData|\bfd\b|str\(|opt\(|requireId\(|\.get\(/;

describe('the census arithmetic (green today: the literal map matches the spec + the audit-round conditionals)', () => {
  it('69 controls: P 33 (36 - the 3 T-418 draft deletes), R 19 (18 + T-464 Un-pair tablet), W 13 (10 + the 3 T-418 draft deletes), X 4; 64 are danger (2 conditional), in 50 files', () => {
    const by = (t: Tier) => rows.filter((r) => r.tier === t).length;
    expect([by('P'), by('R'), by('W'), by('X')]).toEqual([33, 19, 13, 4]); // T-418: three draft deletes moved P -> W; T-464: +1 R
    expect(rows).toHaveLength(69); // T-464: +Un-pair tablet
    expect(rows.filter((r) => r.danger)).toHaveLength(64);
    expect(rows.filter((r) => r.conditional)).toHaveLength(2);
    expect(new Set(rows.filter((r) => r.danger).map((r) => r.file)).size).toBe(50);
  });
  it('every P / R row names its visible label (audit L8), and no two rows in one file share an action AND a label by accident', () => {
    for (const r of rows.filter((x) => x.tier === 'P' || x.tier === 'R')) {
      expect(r.visible !== undefined || r.visibleRe !== undefined, `${r.file} ${r.label} has a visible label`).toBe(true);
    }
  });
});

describe('every file: ConfirmDestructive count by tier, and what is left bare (V9, M11, M-c1)', () => {
  const files = [...new Set(rows.map((r) => r.file))].sort();
  for (const file of files) {
    const mine = rows.filter((r) => r.file === file);
    const P = mine.filter((r) => r.tier === 'P').length;
    const R = mine.filter((r) => r.tier === 'R').length;
    const bare = mine.filter((r) => r.tier === 'W' || r.tier === 'X').length;
    it(`${file}: ${P} admin-pin, ${R} retype, ${bare} bare danger`, () => {
      const src = read(file);
      const wins = confirmWindows(src);
      expect(wins.filter((w) => tierOf(w) === 'admin-pin'), 'admin-pin ConfirmDestructive count').toHaveLength(P);
      expect(wins.filter((w) => tierOf(w) === 'retype'), 'retype ConfirmDestructive count').toHaveLength(R);
      expect(wins.filter((w) => tierOf(w) === undefined), 'a ConfirmDestructive with no recognisable tier').toHaveLength(0);
      // the bare danger buttons that remain outside ConfirmDestructive are exactly the W and X rows
      expect(count(src, DANGER), 'variant="danger" left in the file').toBe(bare);
      // audit L8: each guarded row's VISIBLE label is asserted, so a renamed label (or a button that lost its guard) is caught
      for (const r of mine.filter((x) => x.tier === 'P' || x.tier === 'R')) {
        const hit = wins.filter((w) => tierOf(w) === (r.tier === 'P' ? 'admin-pin' : 'retype')).find((w) => {
          const lab = /label=(?:"([^"]*)"|\{['"]([^'"]*)['"]\})/.exec(w);
          const text = lab ? (lab[1] ?? lab[2] ?? '') : '';
          return r.visible !== undefined ? text === r.visible : r.visibleRe!.test(text);
        });
        expect(hit, `a ${r.tier === 'P' ? 'admin-pin' : 'retype'} ConfirmDestructive labelled ${String(r.visible ?? r.visibleRe)}`).toBeDefined();
        // ... and it sits inside the form that submits to THAT row's action (a label guarding the wrong action is no guard)
        if (hit && r.action) {
          const at = src.indexOf(hit);
          const { start: formAt, between } = enclosingForm(src, at);
          expect(formAt, `${r.visible ?? r.label}: a <form> or <CheckedForm> precedes its ConfirmDestructive`).toBeGreaterThan(-1);
          expect(between, `${r.visible ?? r.label}: no form end tag between its form and the button`).not.toMatch(FORM_END);
          expect(between, `${r.visible ?? r.label}: its <form submits to ${r.action}`).toMatch(new RegExp('action=' + BS + '{[^}]*(?<![A-Za-z0-9_])' + r.action + '(?![A-Za-z0-9_])'));
        }
      }
      for (const w of wins) {
        expect(w, 'ConfirmDestructive names its button').toMatch(/label=/);
        expect(w, 'ConfirmDestructive says what happens').toMatch(/consequence=/);
        if (tierOf(w) === 'retype') expect(w, 'a retype panel needs the record name to show').toMatch(/expectedName=/);
      }
    });
  }

  it('no OTHER file in apps/erp/src carries a danger button or a ConfirmDestructive (a new one must be classified above)', () => {
    const known = new Set(files);
    const stray: string[] = [];
    for (const abs of walk(SRC)) {
      const r = rel(abs);
      if (known.has(r) || r.startsWith('components/ui/ConfirmDestructive') || r === 'components/ui/index.ts') continue;
      const src = readFileSync(abs, 'utf8');
      if (count(src, DANGER) > 0 || src.includes('<ConfirmDestructive')) stray.push(r);
    }
    expect(stray).toEqual([]);
  });

  it('audit H1 / H2: every danger string literal outside components/ui (and outside tone=) sits on a variant= line the census counts (no danger button hides behind a variable)', () => {
    const bad: string[] = [];
    for (const abs of walk(SRC)) {
      const r = rel(abs);
      if (r.startsWith('components/ui/')) continue;
      const src = stripComments(readFileSync(abs, 'utf8'));
      const literals = src.split(String.fromCharCode(10)).filter((ln) => /['"]danger['"]/.test(ln) && !/tone/i.test(ln)).length;
      const counted = src.split(String.fromCharCode(10)).filter((ln) => /['"]danger['"]/.test(ln) && !/tone/i.test(ln) && /variant=/i.test(ln)).length; // T-448 A3: /i so FormModal's triggerVariant="danger" counts as a variant line
      if (literals !== counted) bad.push(`${r}: ${literals} danger literals, ${counted} on a variant= line`);
    }
    expect(bad).toEqual([]);
  });

  it('the total of controls = bare danger + ConfirmDestructive across src is exactly 68 (66 + DEF-654 Void collection + Retire liability)', () => {
    let total = 0;
    for (const abs of walk(SRC)) {
      const r = rel(abs);
      if (r.startsWith('components/ui/ConfirmDestructive') || r === 'components/ui/index.ts') continue;
      const src = readFileSync(abs, 'utf8');
      total += count(src, DANGER) + confirmWindows(src).length;
    }
    expect(total).toBe(69);
  });
});

describe('Tier P: every action verifies the admin PIN on the server, before the mutation (V1, V6, M1, M8)', () => {
  for (const row of rows.filter((r) => r.tier === 'P')) {
    it(`${row.actionFile} ${row.action} (${row.label})`, () => {
      const src = read(row.actionFile!);
      const body = functionBody(src, row.action!);
      expect(body, `${row.action} is exported from ${row.actionFile}`).toBeDefined();
      const call = body!.indexOf('verifyAdminApproval(');
      expect(call, 'the action calls verifyAdminApproval(').toBeGreaterThan(-1);
      const mutations = [...body!.matchAll(new RegExp('(?<![A-Za-z0-9_])' + row.mutation + '\\(', 'g'))].map((m) => m.index);
      expect(mutations.length, `the mutation ${row.mutation}( is still called in the action`).toBeGreaterThan(0);
      expect(Math.min(...mutations), 'verifyAdminApproval( comes BEFORE the mutation').toBeGreaterThan(call);
      // the pin is the one thing taken from the form, under the one field name
      expect(body!, 'the PIN is read from the adminPin field').toMatch(/['"]adminPin['"]/);
      const args = balanced(body!, call + 'verifyAdminApproval'.length);
      expect(args, 'the capability is named').toMatch(/capability/);
      // V6: the store is the RECORD's, never a form field
      const storeProp = /storeId\s*:\s*([^,}\n]+)/.exec(args);
      if (storeProp) {
        expect(storeProp[1]!, 'storeId is not read from the form').not.toMatch(FORM_READ);
      } else {
        expect(args, 'storeId is passed (shorthand)').toMatch(/storeId/);
        const init = /(?:const|let)\s+(?:\{[^}]*\bstoreId\b[^}]*\}|storeId)\s*=\s*([^;]+);/.exec(body!);
        if (init) expect(init[1]!, 'the storeId variable is not read from the form').not.toMatch(FORM_READ);
      }
    });
  }
});

describe('DEF-654: no destructive SERVER ACTION hides behind a non-danger button (the danger-variant scan cannot see it)', () => {
  // A control can be a plain <button> or a secondary <Button> and still reverse posted money (DEF-654: the collection 'void').
  // So the census is ALSO driven from the server actions: every exported action in a 'use server' file under app/ whose NAME or
  // whose BODY calls a void / reverse / writeOff / dispose / delete / cancel / reopen function must be either (a) the `action`
  // of a row in the table above, or (b) in EXEMPT below with the reason it moves no posted money. A new one is red until classified.
  // MUTANT M-s1: add `export async function voidThingAction` to any actions.ts -> red here. M-s2: delete the voidCollectionAction
  // row -> red here (and in the arithmetic).
  const EXEMPT: Record<string, string> = {
    'app/menu/prices/actions.ts#cancelScheduledPriceAction': 'clears a FUTURE menu price offer; no ledger, no stock',
    'app/menu/prices/actions.ts#cancelScheduledOptionPriceAction': 'clears a FUTURE option price offer; no ledger, no stock',
    'app/staff/actions.ts#reopenPinSignInAction': 'lifts a staff sign-in lock; not a money record',
    'app/attendance/leave/actions.ts#cancelLeaveAction': 'T-436: withdraws a pending leave request; nothing is paid or posted yet',
    'app/attendance/leave/actions.ts#voidLeaveAction': 'T-436: voids a leave day; a day frozen to a pay run is refused (LEAVE_DAY_PAID), so no posted money moves',
  };
  // Tier P by BRANCH: a select-driven form (no danger button, no ConfirmDestructive) whose action only forgives money on one
  // branch. It cannot be a row in `rows` (those are controls with a ConfirmDestructive); it is classified here and asserted below.
  const BRANCH_P = [
    { key: 'app/owners/actions.ts#settleAction', branch: 'writeoff', mutation: 'writeOffReceivable' },
  ];
  const TRIGGER = /(?<![A-Za-z])(?:void|reverse|writeOff|dispose|delete|cancel|reopen)[A-Za-z0-9]*\(/;
  function exportedActions(src: string): { name: string; body: string }[] {
    const out: { name: string; body: string }[] = [];
    const re = /export async function ([A-Za-z0-9_]+)/g;
    const hits = [...src.matchAll(re)];
    hits.forEach((m, i) => {
      const end = i + 1 < hits.length ? hits[i + 1]!.index! : src.length;
      out.push({ name: m[1]!, body: stripComments(src.slice(m.index!, end)) });
    });
    return out;
  }
  const found: { key: string; file: string; name: string }[] = [];
  for (const abs of walk(join(SRC, 'app'))) {
    const src = readFileSync(abs, 'utf8');
    if (!/^\s*['"]use server['"]/m.test(src)) continue;
    for (const a of exportedActions(src)) {
      const bodyAfterSignature = a.body.slice(a.body.indexOf('{'));
      if (/^(?:void|reverse|writeOff|dispose|delete|cancel|reopen)/i.test(a.name) || TRIGGER.test(bodyAfterSignature)) {
        found.push({ key: `${rel(abs)}#${a.name}`, file: rel(abs), name: a.name });
      }
    }
  }
  const classified = new Set(rows.filter((r) => r.action && r.actionFile).map((r) => `${r.actionFile}#${r.action}`));

  it('every destructive-looking server action is a row in the census table or an exempt one with a reason', () => {
    const unclassified = found.filter((f) => !classified.has(f.key) && !(f.key in EXEMPT) && !BRANCH_P.some((b) => b.key === f.key)).map((f) => f.key);
    expect(unclassified, 'classify each in `rows` (tier P / R / W) or in EXEMPT with its reason').toEqual([]);
  });
  it('the scan is not vacuous: it finds the known actions, and every exemption still names a real action', () => {
    expect(found.length).toBeGreaterThan(30);
    expect(found.map((f) => f.key)).toContain('app/customers/actions.ts#voidCollectionAction');
    for (const k of Object.keys(EXEMPT)) expect(found.map((f) => f.key), `${k} still exists and still matches`).toContain(k);
  });
  for (const bp of BRANCH_P) {
    it(`${bp.key} is Tier P on its \`${bp.branch}\` branch: verifyAdminApproval( INSIDE that branch block, before ${bp.mutation}(, store from the record, other branches unguarded`, () => {
      const [file, name] = bp.key.split('#') as [string, string];
      const body = functionBody(read(file), name);
      expect(body, `${name} exists`).toBeDefined();
      const at = body!.search(new RegExp("how === '" + bp.branch + "'"));
      expect(at, `the ${bp.branch} branch exists`).toBeGreaterThan(-1);
      const open = body!.indexOf('{', at);
      let depth = 0;
      let end = body!.length;
      for (let i = open; i < body!.length; i++) {
        if (body![i] === '{') depth++;
        else if (body![i] === '}' && --depth === 0) { end = i; break; }
      }
      const block = body!.slice(open, end);
      const outside = body!.slice(0, open) + body!.slice(end);
      const call = block.indexOf('verifyAdminApproval(');
      expect(call, 'verifyAdminApproval( is inside the branch block').toBeGreaterThan(-1);
      const mut = block.indexOf(bp.mutation + '(');
      expect(mut, `${bp.mutation}( is inside the branch block`).toBeGreaterThan(-1);
      expect(call, 'before the mutation').toBeLessThan(mut);
      expect(block, 'the PIN is read from the adminPin field').toMatch(/['"]adminPin['"]/);
      const args = balanced(block, call + 'verifyAdminApproval'.length);
      expect(args, 'the capability is named').toMatch(/capability/);
      const storeProp = /storeId\s*:\s*([^,}\n]+)/.exec(args);
      expect(storeProp, 'storeId is passed').not.toBeNull();
      expect(storeProp![1]!, 'storeId is not read from the form').not.toMatch(FORM_READ);
      expect(outside, 'no verifyAdminApproval( outside the branch (the other branches move money back, they forgive nothing)').not.toContain('verifyAdminApproval(');
      expect(outside, `${bp.mutation}( is only called inside the branch`).not.toContain(bp.mutation + '(');
    });
  }
});

describe('Tier R: every action compares the typed name with the one it loads (V8, M10)', () => {
  for (const row of rows.filter((r) => r.tier === 'R')) {
    it(`${row.actionFile} ${row.action} (${row.label})`, () => {
      const src = read(row.actionFile!);
      const body = functionBody(src, row.action!);
      expect(body, `${row.action} is exported from ${row.actionFile}`).toBeDefined();
      const call = body!.indexOf('retypeMatches(');
      expect(call, 'the action calls retypeMatches(').toBeGreaterThan(-1);
      const mutations = [...body!.matchAll(new RegExp('(?<![A-Za-z0-9_])' + row.mutation + '\\(', 'g'))].map((m) => m.index);
      expect(mutations.length, `the mutation ${row.mutation}( is still called in the action`).toBeGreaterThan(0);
      expect(Math.min(...mutations), 'retypeMatches( comes BEFORE the mutation').toBeGreaterThan(call);
      expect(body!, 'the typed value comes from the confirmName field').toMatch(/['"]confirmName['"]/);
      const args = topLevelArgs(balanced(body!, call + 'retypeMatches'.length));
      expect(args.length, 'retypeMatches(typed, expected)').toBe(2);
      expect(args[1]!, 'the expected name is NOT read from the form').not.toMatch(FORM_READ);
    });
  }
});

describe('Tier W: reject / withdraw / cancel steps stay unguarded (Ian Q2, recommended option)', () => {
  for (const row of rows.filter((r) => r.tier === 'W' && r.action)) {
    it(`${row.actionFile} ${row.action} (${row.label}) calls neither guard`, () => {
      const body = functionBody(read(row.actionFile!), row.action!);
      expect(body, `${row.action} is exported from ${row.actionFile}`).toBeDefined();
      expect(body!).not.toMatch(/verifyAdminApproval\(/);
      expect(body!).not.toMatch(/retypeMatches\(/);
    });
  }
});

describe('T-418: the three draft deletes are Tier W with no approval step; the cutover opening figure stays Tier P', () => {
  const drafts = [
    { file: 'app/expenses/actions.ts', fn: 'deleteDraftAction' },
    { file: 'app/inventory/usage/actions.ts', fn: 'deleteUsageDraftAction' },
    { file: 'app/expenses/recurring/actions.ts', fn: 'deleteTemplateAction' },
  ];
  for (const d of drafts) {
    it(`${d.fn} reads no adminPin and writes no approval row`, () => {
      const body = functionBody(read(d.file), d.fn);
      expect(body, `${d.fn} exists`).toBeDefined();
      expect(body!).not.toMatch(/verifyAdminApproval\(|recordApproval\(|loadDestructiveTarget\(/);
      expect(body!).not.toMatch(/['"]adminPin['"]/);
    });
  }
  it('Remove opening figure is still Tier P (Ian 16 Oct, answer 1)', () => {
    const r = rows.find((x) => x.label === 'Remove opening figure');
    expect(r?.tier).toBe('P');
    expect(functionBody(read('app/cutover/actions.ts'), 'removeOpeningFigureAction')!).toMatch(/verifyAdminApproval\(/);
  });
});

describe('no client flag is ever a gate (spec: nothing named confirmed / approved / pinOk / verified is read from the form)', () => {
  // The ONE pre-existing look-alike: menu/requests submitItemRequestAction reads `confirmed` to mean "send the request even
  // though similar names exist" (a duplicate-name warning, not a destructive gate; it must equal a server-derived token of the
  // typed name). Allow-listed by name so the guard is exact; reported to the planner as a spec gap.
  const ALLOWED = new Set(['app/menu/requests/actions.ts']);
  it('no file under app/ reads formData / fd for confirmed | approved | pinOk | verified', () => {
    const re = /\(\s*(?:[A-Za-z_][A-Za-z0-9_.]*\s*,\s*)?['"](?:confirmed|approved|pinOk|verified)['"]\s*\)/;
    const hits: string[] = [];
    for (const abs of walk(join(SRC, 'app'))) {
      const r = rel(abs);
      if (ALLOWED.has(r)) continue;
      if (re.test(stripComments(readFileSync(abs, 'utf8')))) hits.push(r);
    }
    expect(hits).toEqual([]);
  });
  it('the allow-list is still needed (it names a file that really reads `confirmed`), so it cannot rot into a blanket pass', () => {
    expect(read('app/menu/requests/actions.ts')).toMatch(/['"]confirmed['"]/);
  });
});

describe('ConfirmDestructive.tsx and retype.ts have the shape the spec fixes (S2)', () => {
  const comp = 'components/ui/ConfirmDestructive.tsx';
  it('the component exists, is a client component, and renders the two fields with the exact attributes', () => {
    expect(existsSync(join(SRC, comp)), `${comp} exists`).toBe(true);
    const s = read(comp);
    expect(s.trimStart().startsWith("'use client'"), "'use client' is the first statement").toBe(true);
    expect(s).toMatch(/name="confirmName"/);
    expect(s).toMatch(/name="adminPin"/);
    expect(s).toMatch(/type="password"/);
    expect(s).toMatch(/inputMode="numeric"/);
    expect(s).toMatch(/autoComplete="off"/);
    expect(s).toMatch(/maxLength=\{6\}/);
    expect(s).toMatch(/variant="danger"/);
    expect(s, 'the submit button shows the label prop (audit L8: the visible label IS the prop)').toMatch(/\{label\}/);
    expect(s, 'no browser confirm() dialog').not.toMatch(/window\.confirm|[^A-Za-z.]confirm\(/);
    expect(s, 'a client component must not pull the database into the browser bundle').not.toMatch(/@shareat\/db/);
    expect(s, 'the client never imports the server-only approval check').not.toMatch(/verifyAdminApproval/);
  });
  it('it is exported from components/ui/index.ts', () => {
    expect(read('components/ui/index.ts')).toMatch(/ConfirmDestructive/);
  });
  it('retype.ts exists and exports retypeMatches', () => {
    expect(existsSync(join(SRC, 'lib/retype.ts')), 'lib/retype.ts exists').toBe(true);
    expect(read('lib/retype.ts')).toMatch(/export function retypeMatches/);
  });
});

describe('T-S1-16 (T-440 A3): a ConfirmDestructive inside a <CheckedForm action={x}> satisfies the census (mutant: the tag search reverted to <form only)', () => {
  const src = `<CheckedForm rules={R} action={voidThingAction}>
    <ConfirmDestructive tier="admin-pin" label="Void thing" consequence="x" />
  </CheckedForm>`;
  const at = () => src.indexOf(confirmWindows(src)[0]!);
  it('the enclosing form is found, nothing closes it, and its action is the one named', () => {
    const { start, between } = enclosingForm(src, at());
    expect(start, 'a <CheckedForm precedes the button').toBeGreaterThan(-1);
    expect(between).not.toMatch(FORM_END);
    expect(between).toMatch(new RegExp('action=' + BS + '{[^}]*(?<![A-Za-z0-9_])voidThingAction(?![A-Za-z0-9_])'));
  });
  it('a CheckedForm CLOSED before the button no longer encloses it (the end-tag check sees </CheckedForm>)', () => {
    const closed = `<CheckedForm action={a}></CheckedForm><ConfirmDestructive tier="retype" label="x" consequence="y" />`;
    const { start, between } = enclosingForm(closed, closed.indexOf(confirmWindows(closed)[0]!));
    expect(start).toBeGreaterThan(-1);
    expect(between).toMatch(FORM_END);
  });
  it('a native <form> still works, and the nearest opener wins', () => {
    const mixed = `<form action={a}><CheckedForm action={b}><ConfirmDestructive tier="retype" label="x" consequence="y" /></CheckedForm></form>`;
    const { between } = enclosingForm(mixed, mixed.indexOf(confirmWindows(mixed)[0]!));
    expect(between.startsWith('<CheckedForm')).toBe(true);
    const plain = `<form action={a}><ConfirmDestructive tier="retype" label="x" consequence="y" /></form>`;
    expect(enclosingForm(plain, plain.indexOf(confirmWindows(plain)[0]!)).start).toBe(0);
  });
});
