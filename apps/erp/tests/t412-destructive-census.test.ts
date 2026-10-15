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
  /** P / R / guarded W only: the server action the form submits to. */
  action?: string;
  actionFile?: string;
  /** The domain / repo call that mutates; every occurrence must come AFTER the guard. A regex source, matched as `NAME(`. */
  mutation?: string;
}

const rows: Row[] = [
  // ---- Tier P (35): an administrator's PIN ----
  { file: 'app/ap/invoices/[id]/page.tsx', tier: 'P', label: 'Void payment', danger: true, action: 'voidPaymentAction', actionFile: 'app/ap/actions.ts', mutation: 'voidPayment' },
  { file: 'app/ap/invoices/[id]/page.tsx', tier: 'P', label: 'Void invoice', danger: true, action: 'voidInvoiceAction', actionFile: 'app/ap/actions.ts', mutation: 'voidInvoice' },
  { file: 'app/attendance/[dayId]/page.tsx', tier: 'P', label: 'Void day', danger: true, action: 'voidDayAction', actionFile: 'app/attendance/[dayId]/actions.ts', mutation: 'decide' },
  { file: 'app/channel-settlements/page.tsx', tier: 'P', label: 'Void settlement', danger: true, action: 'voidSettlementAction', actionFile: 'app/channel-settlements/actions.ts', mutation: 'voidChannelSettlement' },
  { file: 'app/commissary/orders/[id]/page.tsx', tier: 'P', label: 'Void dispatch', danger: true, action: 'withdrawOrderAction', actionFile: 'app/commissary/orders/[id]/actions.ts', mutation: 'voidTradeOrder' },
  { file: 'app/customers/[customerId]/page.tsx', tier: 'P', label: 'Write off as bad debt', danger: true, action: 'writeOffChargeAction', actionFile: 'app/customers/actions.ts', mutation: 'writeOffCharge' },
  { file: 'app/customers/[customerId]/page.tsx', tier: 'P', label: 'Void charge', danger: true, action: 'voidChargeAction', actionFile: 'app/customers/actions.ts', mutation: 'voidCharge' },
  { file: 'app/cutover/opening/page.tsx', tier: 'P', label: 'Remove opening figure', danger: true, action: 'removeOpeningFigureAction', actionFile: 'app/cutover/actions.ts', mutation: 'removeOpeningFigure' },
  { file: 'app/cutover/opening/page.tsx', tier: 'P', label: 'Post the opening balances', danger: false, action: 'postOpeningBalancesAction', actionFile: 'app/cutover/actions.ts', mutation: 'postOpeningBalances' },
  { file: 'app/expenses/[id]/page.tsx', tier: 'P', label: 'Delete draft', danger: true, action: 'deleteDraftAction', actionFile: 'app/expenses/actions.ts', mutation: 'deleteExpenseDraft' },
  { file: 'app/expenses/[id]/page.tsx', tier: 'P', label: 'Void expense', danger: true, action: 'voidExpenseAction', actionFile: 'app/expenses/actions.ts', mutation: 'voidExpense' },
  { file: 'app/expenses/recurring/page.tsx', tier: 'P', label: 'Delete template', danger: true, action: 'deleteTemplateAction', actionFile: 'app/expenses/recurring/actions.ts', mutation: 'deleteRecurringTemplate' },
  { file: 'app/fixed-assets/[id]/page.tsx', tier: 'P', label: 'Dispose', danger: true, action: 'disposeAssetAction', actionFile: 'app/fixed-assets/actions.ts', mutation: 'disposeAsset' },
  { file: 'app/inventory/pos-usage/page.tsx', tier: 'P', label: 'Void this pull', danger: true, action: 'voidPullAction', actionFile: 'app/inventory/pos-usage/actions.ts', mutation: 'voidPosUsagePull' },
  { file: 'app/inventory/production/[id]/page.tsx', tier: 'P', label: 'Void production', danger: true, action: 'voidProductionAction', actionFile: 'app/inventory/production/actions.ts', mutation: 'voidProduction' },
  { file: 'app/inventory/returns/page.tsx', tier: 'P', label: 'Void supplier return', danger: true, action: 'voidReturnAction', actionFile: 'app/inventory/returns/actions.ts', mutation: 'voidReturn' },
  { file: 'app/inventory/transfers/page.tsx', tier: 'P', label: 'Void transfer', danger: true, action: 'voidTransferAction', actionFile: 'app/inventory/transfers/actions.ts', mutation: 'voidTransfer' },
  { file: 'app/inventory/usage/[id]/page.tsx', tier: 'P', label: 'Delete usage draft', danger: true, action: 'deleteUsageDraftAction', actionFile: 'app/inventory/usage/actions.ts', mutation: 'deleteUsageDraft' },
  { file: 'app/inventory/usage/[id]/page.tsx', tier: 'P', label: 'Void usage', danger: true, action: 'voidUsageAction', actionFile: 'app/inventory/usage/actions.ts', mutation: 'voidUsage' },
  { file: 'app/liabilities/[id]/page.tsx', tier: 'P', label: 'Reverse liability entry', danger: true, action: 'reverseAction', actionFile: 'app/liabilities/actions.ts', mutation: 'reverseLiabilityEntry' },
  { file: 'app/loans/[id]/page.tsx', tier: 'P', label: 'Reverse loan entry', danger: true, action: 'reverseEntryAction', actionFile: 'app/loans/actions.ts', mutation: 'reverseLoanEntry' },
  { file: 'app/money-transfers/page.tsx', tier: 'P', label: 'Reverse money transfer', danger: true, action: 'voidMoneyTransferAction', actionFile: 'app/money-transfers/actions.ts', mutation: 'voidMoneyTransfer' },
  { file: 'app/payroll/page.tsx', tier: 'P', label: 'Void pay run', danger: true, action: 'voidPayRunAction', actionFile: 'app/payroll/actions.ts', mutation: 'voidPayRun' },
  { file: 'app/payroll/separations/page.tsx', tier: 'P', label: 'Void separation', danger: true, action: 'voidSeparationAction', actionFile: 'app/payroll/separations/actions.ts', mutation: 'voidSeparation' },
  { file: 'app/payroll/separations/page.tsx', tier: 'P', label: 'Post separation', danger: false, action: 'postSeparationAction', actionFile: 'app/payroll/separations/actions.ts', mutation: 'postSeparation' },
  { file: 'app/payroll/thirteenth-month/page.tsx', tier: 'P', label: 'Void 13th-month run', danger: true, action: 'void13thMonthRunAction', actionFile: 'app/payroll/thirteenth-month/actions.ts', mutation: 'void13thMonthRun' },
  { file: 'app/prepaid/[id]/page.tsx', tier: 'P', label: 'Reverse month', danger: true, action: 'reverseMonthAction', actionFile: 'app/prepaid/actions.ts', mutation: 'reverseAmortisation' },
  { file: 'app/prepaid/[id]/page.tsx', tier: 'P', label: 'Write it off', danger: true, action: 'writeOffAction', actionFile: 'app/prepaid/actions.ts', mutation: 'writeOffPrepaidItem' },
  { file: 'app/remittance/page.tsx', tier: 'P', label: 'Reverse remittance', danger: true, action: 'reverseRemittanceAction', actionFile: 'app/remittance/actions.ts', mutation: 'reverseRemittance' },
  { file: 'app/sales-days/[id]/page.tsx', tier: 'P', label: 'Void sales day', danger: true, action: 'voidSalesDayAction', actionFile: 'app/sales-days/actions.ts', mutation: 'voidSalesDay' },
  { file: 'app/staff/[employmentId]/page.tsx', tier: 'P', label: 'End employment', danger: true, action: 'endEmploymentAction', actionFile: 'app/staff/actions.ts', mutation: 'endEmployment' },
  { file: 'app/statutory-discounts/page.tsx', tier: 'P', label: 'Void statutory discount', danger: true, action: 'voidStatutoryDiscountAction', actionFile: 'app/statutory-discounts/actions.ts', mutation: 'voidStatutoryDiscount' },
  { file: 'app/trade/orders/[id]/page.tsx', tier: 'P', label: 'Void trade order', danger: true, action: 'voidOrderAction', actionFile: 'app/trade/orders/actions.ts', mutation: 'voidTradeOrder' },
  { file: 'app/trade/returns/page.tsx', tier: 'P', label: 'Void customer return', danger: true, action: 'voidReturnAction', actionFile: 'app/trade/returns/actions.ts', mutation: 'voidCustomerReturn' },
  { file: 'app/wastage/[id]/page.tsx', tier: 'P', label: 'Reverse auto charge', danger: true, action: 'reverseAutoChargeAction', actionFile: 'app/wastage/actions.ts', mutation: 'reverseAutoCharge' },
  // ---- Tier R (14): retype the name ----
  { file: 'app/admin/access-defaults/grid.tsx', tier: 'R', label: 'Retire position (row)', danger: true, action: 'retireStorePositionAction', actionFile: 'app/admin/access-defaults/actions.ts', mutation: 'retireStorePosition' },
  { file: 'app/admin/access-defaults/grid.tsx', tier: 'R', label: 'Retire position (column)', danger: true, action: 'retireStorePositionAction', actionFile: 'app/admin/access-defaults/actions.ts', mutation: 'retireStorePosition' },
  { file: 'app/admin/users/[personId]/page.tsx', tier: 'R', label: 'Revoke grant', danger: true, action: 'setCapabilityGrantAction', actionFile: 'app/admin/users/actions.ts', mutation: 'revokeGrantById' },
  { file: 'app/admin/users/[personId]/page.tsx', tier: 'R', label: 'Unlink credential', danger: true, action: 'unlinkCredentialAction', actionFile: 'app/admin/users/actions.ts', mutation: 'unlinkCredential' },
  { file: 'app/attendance/terminals/page.tsx', tier: 'R', label: 'Revoke terminal', danger: true, action: 'revokeTerminalAction', actionFile: 'app/attendance/terminals/actions.ts', mutation: 'revokeTerminal' },
  { file: 'app/budgets/page.tsx', tier: 'R', label: 'Remove cap', danger: true, action: 'removeBudgetAction', actionFile: 'app/budgets/actions.ts', mutation: 'removeExpenseBudget' },
  { file: 'app/commissary/catalogue/page.tsx', tier: 'R', label: 'Remove mapping', danger: true, action: 'removeMapAction', actionFile: 'app/commissary/catalogue/actions.ts', mutation: 'removeMap' },
  { file: 'app/items/[id]/page.tsx', tier: 'R', label: 'Retire item', danger: true, action: 'setItemStatusAction', actionFile: 'app/items/actions.ts', mutation: 'setItemStatus' },
  { file: 'app/menu/page.tsx', tier: 'R', label: 'Retire category', danger: true, action: 'retireCategoryAction', actionFile: 'app/menu/actions.ts', mutation: 'retireMenuCategory' },
  { file: 'app/money-accounts/page.tsx', tier: 'R', label: 'Retire money account', danger: true, action: 'retireMoneyAccountAction', actionFile: 'app/money-accounts/actions.ts', mutation: 'retireMoneyAccount' },
  { file: 'app/settings/pos-link/page.tsx', tier: 'R', label: 'Unlink store from POS', danger: true, action: 'unlinkStoreFromPosAction', actionFile: 'app/settings/pos-link/actions.ts', mutation: 'unlinkStoreFromPos' },
  { file: 'app/settings/pos-link/page.tsx', tier: 'R', label: 'Retire tender', danger: true, action: 'setTenderActiveAction', actionFile: 'app/settings/pos-link/actions.ts', mutation: 'setTenderActive' },
  { file: 'app/staff/[employmentId]/credentials/page.tsx', tier: 'R', label: 'Revoke credential', danger: true, action: 'revokeCredentialAction', actionFile: 'app/staff/[employmentId]/credentials/actions.ts', mutation: 'revokeCredential' },
  { file: 'app/inventory/locations/page.tsx', tier: 'R', label: 'Deactivate room', danger: false, action: 'deactivateLocationAction', actionFile: 'app/inventory/locations/actions.ts', mutation: 'deactivateLocation' },
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
const DANGER = /variant=(?:"danger"|\{['"]danger['"]\})/g;
const count = (s: string, re: RegExp) => (s.match(re) ?? []).length;

/** Every `<ConfirmDestructive ...` opening in the file, with the next 900 characters as its attribute window. */
function confirmWindows(src: string): string[] {
  const parts = src.split('<ConfirmDestructive');
  return parts.slice(1).map((p) => p.slice(0, 900));
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

describe('the census arithmetic (green today: the literal map matches the spec)', () => {
  it('63 controls: P 35, R 14, W 10, X 4; 60 of them are variant="danger" today, in 47 files', () => {
    const by = (t: Tier) => rows.filter((r) => r.tier === t).length;
    expect([by('P'), by('R'), by('W'), by('X')]).toEqual([35, 14, 10, 4]);
    expect(rows).toHaveLength(63);
    expect(rows.filter((r) => r.danger)).toHaveLength(60);
    expect(new Set(rows.filter((r) => r.danger).map((r) => r.file)).size).toBe(47);
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

  it('the total of controls = bare danger + ConfirmDestructive across src is exactly 63', () => {
    let total = 0;
    for (const abs of walk(SRC)) {
      const r = rel(abs);
      if (r.startsWith('components/ui/ConfirmDestructive') || r === 'components/ui/index.ts') continue;
      const src = readFileSync(abs, 'utf8');
      total += count(src, DANGER) + confirmWindows(src).length;
    }
    expect(total).toBe(63);
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
