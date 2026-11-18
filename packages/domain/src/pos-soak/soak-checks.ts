/**
 * T-601 S1 - the soak checklist: a pass/fail list BESIDE the pre-flight, for the Lipa TEST run. docs/tasks/601-pos-soak-readiness.md S1.
 *
 * It decides nothing the pre-flight decides: `evaluatePreflight` items gate the switch to live, and this list is only what an admin reads
 * before the soak. `posSoakChecks` calls `posPreflight` FIRST (the `manage_stores` gate, and the facts already gathered), then reads the
 * few extra facts below, then hands both to `evaluateSoakChecks` (pure, tested without a database). A READ: no audit row, no write.
 */
import { can, type Actor } from '@shareat/auth';
import { accessRepo, businessRulesRepo, organizationsRepo, posPreflightRepo, posV1Repo, posV2Repo, storesRepo, type Tx } from '@shareat/db';
import { loadStoreMenu } from '../menu/load-store-menu';
import { posPreflight, type PreflightDeps, type PreflightResult } from '../pos/preflight';
import { receiptIdentityOf, type ReceiptIdentity } from '../pos/receipt-identity';

export interface SoakCheck {
  readonly code: string;
  readonly label: string;
  readonly ok: boolean;
  /** What to do, in a plain sentence (shown on a failed row). */
  readonly sentence: string;
  /** The screen that fixes it, or null where no screen does. */
  readonly href: string | null;
}

/** The part of the projected store menu the checks read (structural, so the unit test builds it by hand). */
export interface SoakMenu {
  readonly stations: readonly unknown[];
  readonly hours?: unknown;
  readonly items: readonly {
    readonly itemType: string;
    readonly variants: readonly {
      readonly channels: { readonly store: { readonly orderable: boolean; readonly amount?: string | null } };
      readonly optionGroups: readonly unknown[];
    }[];
  }[];
}

/** The facts the pre-flight does not already hold. */
export interface SoakExtra {
  readonly storeId: string;
  readonly menu: SoakMenu;
  readonly mode: 'off' | 'test' | 'live';
  /** An active `pos_terminal_links` row exists for the store. */
  readonly terminalLinked: boolean;
  /** People who sign in here and may approve a correction AND hold a live PIN. */
  readonly approvers: ReadonlySet<string>;
  /** People who sign in here and may ring up sales. */
  readonly sellers: readonly string[];
  /** The 'manager PIN for line actions' rule is saved, and its newest value is On. */
  readonly pinRuleOn: boolean;
  readonly tenders: readonly { readonly kind: string }[];
  readonly identity: ReceiptIdentity;
}

const sold = (v: SoakMenu['items'][number]['variants'][number]): boolean => v.channels.store.orderable && v.channels.store.amount != null;
const hasItem = (menu: SoakMenu, type: string): boolean => menu.items.some((i) => i.itemType === type && i.variants.some(sold));

export function evaluateSoakChecks(pre: PreflightResult, x: SoakExtra): SoakCheck[] {
  const flagged = (code: string): boolean => [...pre.blocking, ...pre.warnings].some((i) => i.code === code);
  const id = x.storeId;
  const checks: SoakCheck[] = [];
  const add = (code: string, label: string, ok: boolean, sentence: string, href: string | null) => checks.push({ code, label, ok, sentence, href });

  add('menu_items', 'Dishes on sale', hasItem(x.menu, 'a_la_carte'), 'No dish is on sale at this store. Add the menu in the ERP.', '/menu');
  add('menu_packages', 'A package with a per-head price', hasItem(x.menu, 'package'), 'No package with a per-head price is on sale here.', '/menu');
  add('menu_refills', 'Refills linked to every package', x.menu.items.some((i) => i.itemType === 'refill') && !flagged('packages_without_refills'), 'Refills are missing or not linked to every package.', '/menu');
  add('menu_flavours', 'A package with a flavour choice', x.menu.items.some((i) => i.itemType === 'package' && i.variants.some((v) => v.optionGroups.length > 0)), 'No package offers a flavour choice.', '/menu');
  add('kitchen_stations', 'Kitchen stations and routes', x.menu.stations.length > 0 && !flagged('items_without_station'), 'Some dishes have no kitchen station, or there are no stations.', `/kitchen?store=${id}`);
  add('menu_dayparts', 'Lunch and dinner windows', x.menu.hours !== undefined, 'No lunch/dinner windows are set; one price applies all day.', '/menu/hours');
  add('stands_presets', 'Stands and discount presets', !flagged('no_stands') && !flagged('no_discount_presets'), 'Load the stands and discount presets (pos:load-setup).', null);
  add('tablet_till', 'Tablet paired and linked to a till', !flagged('no_linked_till'), 'Pair the tablet and link it to a till.', '/settings/pos-tablet');
  add('terminal_link', 'Tablet registered for manager approvals', x.terminalLinked, 'The tablet is not registered for manager approvals, so the end-of-day close will fail.', '/admin/pos-tablets');
  // One approver who is also the only seller cannot approve their own close.
  const approverOk = x.approvers.size >= 2 || x.sellers.some((p) => !x.approvers.has(p));
  add('approver', 'Someone besides the cashier can approve the close', x.approvers.size >= 1 && approverOk, "Nobody but the cashier can approve the close. Give a manager 'approve a POS refund or correction' and a PIN.", '/admin/users');
  add('rules', 'Business rules saved, line PIN on', !flagged('rules_not_seeded') && x.pinRuleOn, "Save the business rules, and turn on 'manager PIN for line actions'.", '/settings/business-rules');
  add('test_mode', 'Store is in TEST mode', x.mode === 'test', 'The store is not in TEST mode.', `/admin/stores/${id}`);
  add('tenders', 'Cash and a wallet method', x.tenders.some((t) => t.kind === 'cash') && x.tenders.some((t) => t.kind === 'wallet'), 'Add Cash and at least one wallet method (GCash).', `/settings/pos-link?store=${id}`);
  add('receipt_issuer', 'Receipt shows the legal name, TIN and address', x.identity.businessName.trim() !== '' && x.identity.tin !== null && x.identity.addressLines.length > 0, 'The receipt will print the store name only. Fill in the legal name, TIN and address.', '/settings/organization');
  add('people', 'Everyone can sign in, and someone can sell', !flagged('no_record_sale_person') && !flagged('staff_without_pin'), 'Someone who must sign in has no PIN, or nobody can sell.', '/staff');
  return checks;
}

export async function posSoakChecks(tx: Tx, actor: Actor, input: { storeId: string }, deps: PreflightDeps): Promise<SoakCheck[]> {
  // The `manage_stores` gate, the store-exists refusal and the facts the checks share: all in the pre-flight, and first.
  const pre = await posPreflight(tx, actor, input, deps);
  const { orgId } = actor;
  const { storeId } = input;

  const menu = (await loadStoreMenu(tx, orgId, storeId)).menu;
  // The same people the tablet's sign-in list shows (`posPreflight` builds the same list; its code is not changed here).
  const signIn: string[] = [];
  for (const c of await posV2Repo.listOpenEmploymentsAtStore(tx, orgId, storeId)) {
    if (await accessRepo.personMaySignInAtStore(tx, c.personId, storeId)) signIn.push(c.personId);
  }
  const withPin = await posPreflightRepo.personIdsWithLivePin(tx, orgId, signIn);
  const approvers = new Set<string>();
  const sellers: string[] = [];
  for (const personId of signIn) {
    const who = { personId, orgId };
    if (withPin.has(personId) && (await can(tx, who, 'approve_pos_correction', { storeId }))) approvers.add(personId);
    if (await can(tx, who, 'record_sale', { storeId })) sellers.push(personId);
  }

  const rows = await businessRulesRepo.listRuleValueRows(tx, orgId, ['pos.require_pin_line_actions']);
  const newest = [...rows].sort((a, b) => String(b.effectiveFrom).localeCompare(String(a.effectiveFrom)) || String(b.createdAt).localeCompare(String(a.createdAt)))[0];

  const storeRow = await storesRepo.getById(tx, orgId, storeId);
  const identity = receiptIdentityOf(
    (await organizationsRepo.identityOf(tx, orgId)) ?? { name: '', legalName: null, tin: null },
    storeRow ?? { tinBranchCode: null, address: null, contactNumber: null },
  );

  return evaluateSoakChecks(pre, {
    storeId,
    menu,
    mode: (await posV2Repo.getPosStore(tx, orgId, storeId))?.mode ?? 'off',
    terminalLinked: (await posV2Repo.getActiveTerminalPersonId(tx, orgId, storeId)) !== undefined,
    approvers,
    sellers,
    pinRuleOn: newest !== undefined && newest.value === '1',
    tenders: (await posV1Repo.listTendersByStore(tx, orgId, storeId)).filter((t) => t.isActive),
    identity,
  });
}
