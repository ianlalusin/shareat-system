/**
 * T-533 S3 - the POS pre-flight: what is still missing before a store may be switched on. docs/tasks/533-pos-lipa-switch.md R3.
 *
 * `posPreflight(tx, actor, { storeId }, deps)` is a READ (it writes nothing, no audit row) and admin-only: `manage_stores`, the word `/admin/stores` already uses,
 * checked FIRST. It gathers the facts through the existing repos, then `evaluatePreflight` (pure, tested without a database) turns facts into items.
 * Each item is a plain sentence and the screen that fixes it (null where no screen does). BLOCKING items stop the switch to live (S1 calls this); WARNINGS never do.
 *
 * `deps.keyFilePresent` is the ONE place the bridge key file is looked at, and it answers yes or no: the caller injects it (the page passes a check that the
 * `POS_FIREBASE_SA_KEY_FILE` setting is non-empty), so no value is ever read, kept or printed here.
 *
 * "Badge code" (R3's warning wording) is `employments.staff_code`: NOT NULL with a CHECK on its shape, so a person at the store can never lack one. The warning therefore
 * counts the missing PIN, the only half that can be missing.
 */
import { authorize, can, type Actor } from '@shareat/auth';
import { accessRepo, businessRulesRepo, daypartsRepo, kitchenRepo, manilaToday, posPreflightRepo, posV1Repo, posV2Repo, storesRepo, type Tx } from '@shareat/db';
import { RULE_REGISTRY, type BusinessRuleKey } from '../business-rules/registry';
import { gone } from '../shared/refusal';
import { v1BridgeDateAllowed } from './v1-bridge-payload';

export interface PreflightItem {
  /** A stable name for the item (tests and the page key on it). */
  readonly code: string;
  /** A plain sentence a store owner can read. */
  readonly sentence: string;
  /** The screen that fixes it, or null where no screen does. */
  readonly href: string | null;
}
export interface PreflightResult {
  readonly blocking: PreflightItem[];
  readonly warnings: PreflightItem[];
}

/** Everything the decision needs, as plain values. `evaluatePreflight` is a pure function of this. */
export interface PreflightFacts {
  readonly storeId: string;
  readonly hasPosStoreRow: boolean;
  readonly activeStands: number;
  readonly hasCashTender: boolean;
  /** Active tenders with no v1 name. */
  readonly tendersWithoutAlias: number;
  readonly v1Linked: boolean;
  /** Today is on or before the last day the bridge to v1 runs (2026-12-31). */
  readonly bridgeDateAllowed: boolean;
  readonly tillsWithLivePairing: number;
  /** Labels of the POS business rules that have no saved row for the organisation. */
  readonly rulesNotSeeded: readonly string[];
  readonly recordSalePeople: number;
  /** An active `pos_terminal_links` row exists for the store (the tablet can ask for server approvals). */
  readonly terminalLinked: boolean;
  /** Someone with a live PIN may approve a correction, and that someone is not the only seller (`hasSeparateApprover`). */
  readonly separateApprover: boolean;
  readonly keyFileConfigured: boolean;
  /** T-626: packages on sale now at the store (any hours). */
  readonly packagesOnSale: number;
  /** T-626: packages priced for some of the store's hours but not all, as "Name (no Dinner price)" (`packagesMissingHours`: only hours some package is priced in count). */
  readonly packagesMissingHours: readonly string[];
  /** T-626: packages on sale with no kitchen station. */
  readonly packagesWithoutStation: readonly string[];
  readonly itemsWithoutStation: readonly string[];
  readonly packagesWithoutRefills: readonly string[];
  readonly staffWithoutPin: number;
  readonly activePresets: number;
}

/** The four rules R3 names (VAT, senior/PWD, start hour, table warning). */
const POS_RULE_KEYS: readonly BusinessRuleKey[] = ['tax.vat_percent', 'pos.senior_pwd_discount_percent', 'pos.business_day_start_hour', 'pos.table_warn_minutes'];

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
/** "A, B, C, D, E" and "and 2 more" past five names. */
const nameList = (names: readonly string[]): string => (names.length <= 5 ? names.join(', ') : `${names.slice(0, 5).join(', ')} and ${names.length - 5} more`);

/** One approver who is also the only seller cannot approve their own close. Shared with the soak checklist's `approver` check. */
export function hasSeparateApprover(approvers: ReadonlySet<string>, sellers: readonly string[]): boolean {
  return approvers.size >= 1 && (approvers.size >= 2 || sellers.some((p) => !approvers.has(p)));
}

/**
 * T-626 audit ruling 2: packages priced for some hours but not all, as "Name (no Dinner price)". A package is judged only against the hours in which at least one package
 * of the store is priced (an active daypart nothing is sold in, e.g. a breakfast window, is not a missing price). An all-day price misses nothing. Pure.
 */
export function packagesMissingHours(
  packages: readonly { name: string; allDay: boolean; daypartIds: readonly string[] }[],
  hours: readonly { id: string; name: string }[],
): string[] {
  const priced = new Set(packages.flatMap((p) => p.daypartIds));
  const sold = hours.filter((h) => priced.has(h.id));
  return packages
    .filter((p) => !p.allDay && sold.some((h) => !p.daypartIds.includes(h.id)))
    .map((p) => `${p.name} (no ${sold.filter((h) => !p.daypartIds.includes(h.id)).map((h) => h.name).join(' or ')} price)`);
}

export function evaluatePreflight(f: PreflightFacts): PreflightResult {
  const store = `/admin/stores/${f.storeId}`;
  const blocking: PreflightItem[] = [];
  const warnings: PreflightItem[] = [];
  const block = (code: string, sentence: string, href: string | null) => blocking.push({ code, sentence, href });
  const warn = (code: string, sentence: string, href: string | null) => warnings.push({ code, sentence, href });
  const bridge = f.v1Linked && f.bridgeDateAllowed;

  if (!f.hasPosStoreRow) block('no_pos_store_row', 'The new POS has not been set up for this store yet. Switch the store to test mode on its page first.', store);
  if (f.activeStands === 0) block('no_stands', 'This store has no stands (tables) set up. Load the store setup before the switch.', null);
  if (!f.hasCashTender) block('no_cash_tender', 'This store has no active cash payment method. Add one in the POS link settings.', `/settings/pos-link?store=${f.storeId}`);
  if (bridge && f.tendersWithoutAlias > 0) {
    block('tender_without_alias', `${plural(f.tendersWithoutAlias, 'active payment method has', 'active payment methods have')} no name from the old POS. The daily report to the old POS needs one on each.`, `/settings/pos-link?store=${f.storeId}`);
  }
  if (f.tillsWithLivePairing === 0) block('no_linked_till', 'No till at this store is linked to a paired tablet. Pair the tablet and link it to a till.', '/settings/pos-tablet');
  if (f.rulesNotSeeded.length > 0) {
    block('rules_not_seeded', `These business rules have no saved value yet: ${f.rulesNotSeeded.join('; ')}. Save each one so the POS reads a real value, not a built-in default.`, '/settings/business-rules');
  }
  if (f.recordSalePeople === 0) block('no_record_sale_person', 'Nobody at this store is allowed to ring up sales. Add at least one cashier.', '/staff');
  if (!f.terminalLinked) block('no_terminal_link', 'The tablet is not registered for manager approvals, so the end-of-day close will fail.', '/admin/pos-tablets');
  if (!f.separateApprover) block('no_approver', "Nobody but the cashier can approve the close. Give a manager 'approve a POS refund or correction' and a PIN.", '/admin/users');
  if (bridge && !f.keyFileConfigured) block('no_bridge_key_file', 'The setting POS_FIREBASE_SA_KEY_FILE is not set on the server, so the daily report to the old POS cannot be sent.', null);
  if (f.packagesOnSale === 0) block('no_packages_on_sale', 'This store has no packages on sale, so the tablet would have nothing to start a table with. Load the store menu from the old POS, or add and price the packages.', '/menu/prices');
  if (f.packagesMissingHours.length > 0) {
    block('package_missing_price', `${plural(f.packagesMissingHours.length, 'package has', 'packages have')} no price for some of the store's hours, so the tablet could not sell ${f.packagesMissingHours.length === 1 ? 'it' : 'them'} then: ${nameList(f.packagesMissingHours)}.`, '/menu/prices');
  }
  if (f.packagesWithoutStation.length > 0) {
    block('package_without_station', `${plural(f.packagesWithoutStation.length, 'package has', 'packages have')} no kitchen station, so ${f.packagesWithoutStation.length === 1 ? 'its' : 'their'} orders would never reach the kitchen: ${nameList(f.packagesWithoutStation)}.`, `/kitchen?store=${f.storeId}`);
  }

  if (f.itemsWithoutStation.length > 0) {
    warn('items_without_station', `${plural(f.itemsWithoutStation.length, 'menu item', 'menu items')} on sale here ${f.itemsWithoutStation.length === 1 ? 'has' : 'have'} no kitchen station, so ${f.itemsWithoutStation.length === 1 ? 'it' : 'they'} will not reach the kitchen: ${nameList(f.itemsWithoutStation)}.`, `/kitchen?store=${f.storeId}`);
  }
  if (f.packagesWithoutRefills.length > 0) {
    warn('packages_without_refills', `${plural(f.packagesWithoutRefills.length, 'package', 'packages')} on sale here ${f.packagesWithoutRefills.length === 1 ? 'has' : 'have'} no refill items, so no refill can be asked for: ${nameList(f.packagesWithoutRefills)}.`, '/menu');
  }
  if (f.staffWithoutPin > 0) {
    warn('staff_without_pin', `${plural(f.staffWithoutPin, 'staff member', 'staff')} at this store ${f.staffWithoutPin === 1 ? 'has' : 'have'} no PIN and cannot sign in on the tablet.`, '/staff');
  }
  if (f.activePresets === 0) warn('no_discount_presets', 'This store has no discount presets, so cashiers have no named discount to pick.', null);

  return { blocking, warnings };
}

export interface PreflightDeps {
  /** Whether the bridge key-file setting is configured. Yes or no only: the value is never read here. */
  readonly keyFilePresent: () => boolean;
  /** Tests only: the Manila business date to judge "on or before 2026-12-31" by. */
  readonly today?: string;
}

export async function posPreflight(tx: Tx, actor: Actor, input: { storeId: string }, deps: PreflightDeps): Promise<PreflightResult> {
  await authorize(tx, actor, 'manage_stores', {});
  const { orgId } = actor;
  const { storeId } = input;
  if (!(await storesRepo.getById(tx, orgId, storeId))) throw gone(`posPreflight: store ${storeId} not in org`, 'store');

  const today = deps.today ?? (await manilaToday(tx));
  const tenders = (await posV1Repo.listTendersByStore(tx, orgId, storeId)).filter((t) => t.isActive);

  // The saved rule rows: the registry would answer a default for a missing row, so look at the rows themselves.
  const saved = new Set((await businessRulesRepo.listRuleValueRows(tx, orgId, POS_RULE_KEYS)).map((r) => r.key));
  const rulesNotSeeded = POS_RULE_KEYS.filter((k) => !saved.has(k)).map((k) => RULE_REGISTRY[k].label);

  // The same people the tablet's sign-in list shows (snapshot.ts): an open employment here and `personMaySignInAtStore`.
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

  const offered = await kitchenRepo.offeredItemsWithRoute(tx, orgId, storeId);
  const packages = await posPreflightRepo.listOfferedPackages(tx, orgId, storeId);
  const hours = (await daypartsRepo.listDaypartsOfStore(tx, orgId, storeId)).filter((d) => d.status === 'active');
  const packageItemIds = new Set(packages.map((p) => p.itemId));
  return evaluatePreflight({
    storeId,
    hasPosStoreRow: (await posV2Repo.getPosStore(tx, orgId, storeId)) !== undefined,
    activeStands: (await posV2Repo.listActiveStands(tx, orgId, storeId)).length,
    hasCashTender: tenders.some((t) => t.kind === 'cash'),
    tendersWithoutAlias: tenders.filter((t) => !t.posV1Alias).length,
    v1Linked: (await posV1Repo.getLinkByStore(tx, orgId, storeId)) !== undefined,
    bridgeDateAllowed: v1BridgeDateAllowed(today),
    tillsWithLivePairing: await posPreflightRepo.countTillsWithLivePairing(tx, orgId, storeId),
    rulesNotSeeded,
    recordSalePeople: sellers.length,
    terminalLinked: (await posV2Repo.getActiveTerminalPersonId(tx, orgId, storeId)) !== undefined,
    separateApprover: hasSeparateApprover(approvers, sellers),
    keyFileConfigured: deps.keyFilePresent(),
    packagesOnSale: packages.length,
    packagesMissingHours: packagesMissingHours(packages, hours),
    packagesWithoutStation: packages.filter((p) => !p.hasStation).map((p) => p.name),
    // A package with no station is its own blocking item above, so it is not listed again here.
    itemsWithoutStation: offered.filter((o) => o.stationId === null && !packageItemIds.has(o.itemId)).map((o) => o.name),
    packagesWithoutRefills: await posPreflightRepo.listOfferedPackagesWithoutRefills(tx, orgId, storeId),
    staffWithoutPin: signIn.filter((id) => !withPin.has(id)).length,
    activePresets: (await posV2Repo.listActivePresets(tx, orgId, storeId)).length,
  });
}
