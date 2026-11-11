/**
 * T-524 R3-R5 - seating, ordering, heads, refills, kitchen. docs/tasks/524-pos-v2-domain.md.
 *
 * Every write: authorize FIRST (the store is an explicit input, never the actor's), then R1 (switch on, tablet belongs to the store), then the
 * rule, then the rows, the audit row and ONE bump of `pos_stores.state_version`. Price, name, kind and kitchen station of a line come from the
 * server's menu (`loadStoreMenu` at the line's device time), never from the device. Every create is idempotent by the device's uuid: the same id
 * with the same content writes nothing; with different content it is refused.
 */
import { randomUUID } from 'node:crypto';
import { add, money, type Money } from '@shareat/core/money';
import { authorize, type Actor } from '@shareat/auth';
import { posV2Repo, type Tx } from '@shareat/db';
import { refuse, gone } from '../shared/refusal';
import { assertFieldRules } from '../shared/field-rules-assert';
import { POS_LINE_NOTE_RULES, POS_REASON_RULES } from '../field-rules/pos';
import { loadStoreMenu } from '../menu/load-store-menu';
import type { ProjectedItem, ProjectedStoreMenu, ProjectedVariant } from '../menu/project';
import {
  audit,
  billedHeads,
  deviceTime,
  loadLiveLines,
  recordedDifferently,
  requireContext,
  uuidInput,
  uuidv5,
  wholeNumber,
} from './shared';

type SessionRow = posV2Repo.TableSessionRow;

export interface LineInput {
  lineId: string;
  menuItemId: string;
  variantId?: string;
  qty: number;
  note?: string;
  addedAtDevice: string | Date;
  /** Chosen option values: each adds the store's price delta to the unit price (ruling 9). */
  optionValueIds?: string[];
}

const EXTRA_HEADS = 'extra-heads';
const HEADS_MAX = 200;

function assertOpen(s: SessionRow): void {
  if (s.status !== 'open') throw refuse(`pos: session is ${s.status}`, s.status === 'paid' ? 'This table is already paid.' : 'This table was voided.');
}
export async function lockOpenSession(tx: Tx, orgId: string, storeId: string, sessionId: string): Promise<SessionRow> {
  const s = await posV2Repo.lockSession(tx, orgId, storeId, sessionId);
  if (!s) throw gone(`pos: table session ${sessionId} not found`, 'table');
  assertOpen(s);
  return s;
}

// ---------------------------------------------------------------------------------------------------------------------
// The server's menu prices a line (R4)
// ---------------------------------------------------------------------------------------------------------------------
class MenuAt {
  private readonly cache = new Map<number, ProjectedStoreMenu>();
  constructor(
    private readonly tx: Tx,
    private readonly orgId: string,
    private readonly storeId: string,
  ) {}
  async at(when: Date): Promise<ProjectedStoreMenu> {
    let m = this.cache.get(when.getTime());
    if (!m) {
      m = await loadStoreMenu(this.tx, this.orgId, this.storeId, when);
      this.cache.set(when.getTime(), m);
    }
    return m;
  }
}

/** The menu's answer for one item at one time: the item, its variant and the store offer, or a plain refusal. */
function offerFor(menu: ProjectedStoreMenu, itemId: string, variantId: string | undefined) {
  const item = menu.menu.items.find((i) => i.id === itemId);
  if (!item) {
    const off = menu.menu.notOnPos.find((n) => n.itemId === itemId);
    if (off) throw refuse('pos: item has no kitchen station', `${off.name} has no kitchen station yet, so it cannot be ordered on the POS.`);
    throw refuse('pos: item not on the store menu', 'That item is not on this store\'s menu.');
  }
  const variant: ProjectedVariant | undefined = variantId ? item.variants.find((v) => v.id === variantId) : item.variants.find((v) => v.isDefault) ?? item.variants[0];
  if (!variant) throw refuse('pos: variant not on the menu', `${item.name} does not come in that size.`);
  const offer = variant.channels.store;
  if (!offer.orderable) {
    if (offer.notOffered === 'outside_hours') {
      throw refuse('pos: outside hours', `${item.name} is not served at this hour${offer.availableFrom ? `. It opens at ${offer.availableFrom}` : ''}.`);
    }
    throw refuse('pos: not offered', `${item.name} is not on sale at this store right now.`);
  }
  if (item.stationId === null) throw refuse('pos: item has no kitchen station', `${item.name} has no kitchen station yet, so it cannot be ordered on the POS.`);
  return { item, variant, offer };
}

function optionDelta(item: ProjectedItem, variant: ProjectedVariant, chosen: readonly string[] | undefined): { delta: Money; names: string[] } {
  if (!chosen || chosen.length === 0) return { delta: money('0'), names: [] };
  let delta = money('0');
  const names: string[] = [];
  const perGroup = new Map<string, number>();
  for (const id of new Set(chosen)) {
    const group = variant.optionGroups.find((g) => g.values.some((v) => v.id === id));
    const value = group?.values.find((v) => v.id === id);
    if (!group || !value) throw refuse('pos: option not on the item', `That choice is not available for ${item.name}.`);
    if (!value.channels.store.orderable) throw refuse('pos: option not offered', `${value.name} is not available at this store.`);
    const n = (perGroup.get(group.id) ?? 0) + 1;
    perGroup.set(group.id, n);
    if (n > group.maxSelections || (group.selectionMode === 'single' && n > 1)) {
      throw refuse('pos: too many options', `${group.name}: too many choices for ${item.name}.`);
    }
    delta = add(delta, money(value.channels.store.priceDelta));
    names.push(value.name);
  }
  return { delta, names };
}

/**
 * Existing row for a device lineId: the same content is a replay (skip it); different content is refused. T-556: also the variant, the option set
 * (`choices`) and, for a bundle line, the head count: the line covers `bundleHeads` and the heads above it sit on the derived extra-heads row (`extraHeadsQty`).
 */
function sameLine(existing: posV2Repo.TableSessionLineRow, input: { sessionId: string; menuItemId: string; qty: number; note: string | null; choices: boolean; extraHeadsQty: number | null }): boolean {
  const heads = existing.bundleHeads; // a bundle line's qty is not the heads the device sent
  return (
    existing.sessionId === input.sessionId &&
    existing.menuItemId === input.menuItemId &&
    (existing.note ?? null) === input.note &&
    input.choices &&
    (heads !== null ? (input.qty > heads ? input.qty - heads : null) === input.extraHeadsQty : existing.qty === input.qty)
  );
}

/**
 * T-556/T-557: does a replayed line pick the variant and options the stored line was made with? A line with stored `optionValueIds` compares the sorted distinct id sets.
 * A legacy line (NULL, written before migration 0249) keeps its options only inside `name` (" + A, B"), so they are read from the menu at the line's device time (orderability ignored: a replay may come after a sell-out).
 * shortcut: legacy lines compare the option names in the order sent and as a name suffix, and an item the menu no longer lists is not checked; those lines cannot be backfilled.
 */
async function sameChoices(menus: MenuAt, at: Date, prior: posV2Repo.TableSessionLineRow, l: LineInput): Promise<boolean> {
  const item = (await menus.at(at)).menu.items.find((i) => i.id === l.menuItemId);
  const variant = item && (l.variantId ? item.variants.find((v) => v.id === l.variantId) : item.variants.find((v) => v.isDefault) ?? item.variants[0]);
  if (prior.menuItemVariantId !== (variant?.id ?? l.variantId ?? prior.menuItemVariantId)) return false;
  if (prior.optionValueIds) {
    const want = [...new Set(l.optionValueIds ?? [])].sort();
    return want.length === prior.optionValueIds.length && want.every((id, i) => id === prior.optionValueIds![i]);
  }
  if (!variant) return !l.optionValueIds?.length;
  const all = variant.optionGroups.flatMap((g) => g.values);
  const names = [...new Set(l.optionValueIds ?? [])].map((id) => all.find((v) => v.id === id)?.name);
  if (names.includes(undefined)) return false;
  const stored = prior.name.replace(/ \((up to \d+|extra head)\)$/, '');
  return names.length ? stored.endsWith(` + ${names.join(', ')}`) : !all.some((v) => stored.endsWith(` + ${v.name}`) || stored.endsWith(`, ${v.name}`));
}

function checkLineShape(l: LineInput): { lineId: string; qty: number; note: string | null; at: Date } {
  const lineId = uuidInput(l.lineId, 'The line id');
  const qty = wholeNumber(l.qty, { what: 'The quantity', min: 1, max: 999 });
  const note = assertFieldRules(POS_LINE_NOTE_RULES, { note: l.note ?? '' }).note ?? null;
  return { lineId, qty, note, at: deviceTime(l.addedAtDevice, 'The time of the order') };
}

/**
 * R4: prices and writes the new lines of one session (the session is already locked and open). A package line's input qty is the HEADS; a
 * "(up to N)" bundle becomes one line qty 1 at the bundle amount plus, above N heads, a second line at the extra-head amount whose id is
 * derived from the first (ruling 3), so a replay makes the same id. Returns how many session lines were written (0 = a full replay).
 */
async function writeLines(tx: Tx, actor: Actor, ctx: { storeId: string; pairingId: string | null }, session: SessionRow, lines: LineInput[]): Promise<{ written: posV2Repo.NewSessionLine[]; inputs: number }> {
  if (!Array.isArray(lines) || lines.length < 1 || lines.length > 100) throw refuse('pos: bad line count', 'Add between 1 and 100 lines at a time.');
  const menus = new MenuAt(tx, actor.orgId, ctx.storeId);
  const shaped = lines.map((l) => ({ l, ...checkLineShape(l) }));
  if (new Set(shaped.map((s) => s.lineId)).size !== shaped.length) throw refuse('pos: duplicate line id', 'The same line was sent twice.');
  const existing = new Map((await posV2Repo.getLinesByIds(tx, actor.orgId, ctx.storeId, shaped.map((s) => s.lineId))).map((r) => [r.id, r]));
  const written: posV2Repo.NewSessionLine[] = [];
  let fresh = 0;
  for (const s of shaped) {
    const prior = existing.get(s.lineId);
    if (prior) {
      const extra = prior.bundleHeads !== null ? await posV2Repo.getLine(tx, actor.orgId, ctx.storeId, uuidv5(EXTRA_HEADS, s.lineId)) : undefined;
      const choices = await sameChoices(menus, s.at, prior, s.l);
      if (!sameLine(prior, { sessionId: session.id, menuItemId: s.l.menuItemId, qty: s.qty, note: s.note, choices, extraHeadsQty: extra?.qty ?? null })) throw recordedDifferently();
      continue;
    }
    fresh++;
    const { item, variant, offer } = offerFor(await menus.at(s.at), s.l.menuItemId, s.l.variantId);
    if (item.itemType === 'refill') throw refuse('pos: refill via addLines', `${item.name} is a refill: ask for it from the refill screen.`);
    if (item.itemType === 'package' && session.mode !== 'dine_in') throw refuse('pos: package on take-out', 'A package can only be sold to a table, not take-out.');
    if (offer.amount === null) throw refuse('pos: no amount', `${item.name} has no price here yet.`);
    const { delta, names } = optionDelta(item, variant, s.l.optionValueIds);
    const base = `${item.name}${variant.label ? ` - ${variant.label}` : ''}${names.length ? ` + ${names.join(', ')}` : ''}`;
    const common = {
      orgId: actor.orgId,
      storeId: ctx.storeId,
      sessionId: session.id,
      menuItemId: item.id,
      menuItemVariantId: variant.id,
      kitchenStationId: item.stationId,
      note: s.note,
      bundleHeads: null as number | null,
      optionValueIds: [...new Set(s.l.optionValueIds ?? [])].sort(),
      addedBy: actor.personId,
      addedOnPairingId: ctx.pairingId,
      addedAtDevice: s.at,
    };
    if (item.itemType === 'package') {
      const unit = add(money(offer.amount), delta);
      if (offer.bundleHeads !== null && offer.bundleHeads > 1) {
        written.push({ ...common, id: s.lineId, kind: 'package', name: `${base} (up to ${offer.bundleHeads})`, qty: 1, unitPrice: unit, bundleHeads: offer.bundleHeads });
        if (s.qty > offer.bundleHeads) {
          if (offer.extraHeadAmount === null) throw refuse('pos: no extra-head amount', `${item.name} has no price for extra heads here yet.`);
          written.push({ ...common, id: uuidv5(EXTRA_HEADS, s.lineId), kind: 'package', name: `${base} (extra head)`, qty: s.qty - offer.bundleHeads, unitPrice: money(offer.extraHeadAmount) });
        }
      } else {
        written.push({ ...common, id: s.lineId, kind: 'package', name: base, qty: s.qty, unitPrice: unit });
      }
    } else {
      written.push({ ...common, id: s.lineId, kind: 'item', name: base, qty: s.qty, unitPrice: add(money(offer.amount), delta) });
    }
  }
  await posV2Repo.insertLines(tx, written);
  return { written, inputs: fresh };
}

const lineAudit = (written: posV2Repo.NewSessionLine[]) =>
  written.map((l) => ({ lineId: l.id, kind: l.kind, qty: l.qty, unitPrice: l.unitPrice, stationId: l.kitchenStationId }));

// ---------------------------------------------------------------------------------------------------------------------
// R3 openStand
// ---------------------------------------------------------------------------------------------------------------------
export interface OpenStandInput {
  storeId: string;
  pairingId: string | null;
  sessionId: string;
  mode: 'dine_in' | 'take_out';
  standId?: string;
  headsCashier: number;
  openedAtDevice: string | Date;
  lines?: LineInput[];
}

export async function openStand(tx: Tx, actor: Actor, input: OpenStandInput): Promise<{ wrote: boolean; sessionId: string }> {
  await authorize(tx, actor, 'record_sale', { storeId: input.storeId });
  const pairingId = await requireContext(tx, actor, input.storeId, input.pairingId, false);
  const sessionId = uuidInput(input.sessionId, 'The table id');
  if (input.mode !== 'dine_in' && input.mode !== 'take_out') throw refuse('pos: bad mode', 'Choose dine-in or take-out.');
  const at = deviceTime(input.openedAtDevice, 'The opening time');
  const heads = wholeNumber(input.headsCashier, { what: 'The number of guests', min: input.mode === 'dine_in' ? 1 : 0, max: HEADS_MAX });
  if (input.mode === 'take_out' && input.standId) throw refuse('pos: take-out with a stand', 'A take-out order has no stand.');
  if (input.mode === 'dine_in' && !input.standId) throw refuse('pos: dine-in without a stand', 'Choose the stand for this table.');
  const standId = input.mode === 'dine_in' ? uuidInput(input.standId, 'The stand') : null;

  const prior = await posV2Repo.getTableSession(tx, actor.orgId, input.storeId, sessionId);
  if (prior) {
    if (prior.mode === input.mode && prior.standId === standId && prior.headsCashier === heads) return { wrote: false, sessionId };
    throw recordedDifferently();
  }
  if (standId) {
    const stand = await posV2Repo.getStand(tx, actor.orgId, input.storeId, standId);
    if (!stand) throw gone(`pos: stand ${standId} not found`, 'stand');
    if (stand.status !== 'active') throw refuse('pos: stand retired', `Stand ${stand.number} is not in use any more.`);
    const busy = (await posV2Repo.listOpenSessions(tx, actor.orgId, input.storeId)).some((s) => s.standId === standId);
    if (busy) throw refuse('pos: stand in use', `Stand ${stand.number} is already in use.`);
  }
  try {
    await posV2Repo.insertSession(tx, { id: sessionId, orgId: actor.orgId, storeId: input.storeId, standId, mode: input.mode, headsCashier: heads, openedBy: actor.personId, openedAtDevice: at, openedOnPairingId: pairingId! });
  } catch (err) {
    if (isUniqueViolation(err, 'table_sessions_one_open_per_stand_key')) throw refuse('pos: stand in use (race)', 'That stand is already in use.');
    throw err;
  }
  await audit(tx, actor, 'pos.stand_opened', { storeId: input.storeId, entityId: sessionId, pairingId, at, after: { mode: input.mode, standId, heads } });
  if (input.lines && input.lines.length > 0) {
    const session = (await posV2Repo.getTableSession(tx, actor.orgId, input.storeId, sessionId))!;
    const { written } = await writeLines(tx, actor, { storeId: input.storeId, pairingId }, session, input.lines);
    await audit(tx, actor, 'pos.lines_added', { storeId: input.storeId, entityId: sessionId, pairingId, at, after: { lines: lineAudit(written) } });
  }
  await posV2Repo.bumpStateVersion(tx, actor.orgId, input.storeId);
  return { wrote: true, sessionId };
}

function isUniqueViolation(err: unknown, constraint: string): boolean {
  for (let e: unknown = err, i = 0; e && i < 4; i++, e = (e as { cause?: unknown }).cause) {
    const x = e as { code?: string; constraint_name?: string };
    if (x.code === '23505' && x.constraint_name === constraint) return true;
  }
  return false;
}
export { isUniqueViolation };

// ---------------------------------------------------------------------------------------------------------------------
// R4 addLines (phone ok)
// ---------------------------------------------------------------------------------------------------------------------
export async function addLines(tx: Tx, actor: Actor, input: { storeId: string; pairingId: string | null; sessionId: string; lines: LineInput[] }): Promise<{ wrote: boolean }> {
  await authorize(tx, actor, 'record_sale', { storeId: input.storeId });
  const pairingId = await requireContext(tx, actor, input.storeId, input.pairingId, true);
  const sessionId = uuidInput(input.sessionId, 'The table id');
  const session = await posV2Repo.lockSession(tx, actor.orgId, input.storeId, sessionId);
  if (!session) throw gone(`pos: table session ${sessionId} not found`, 'table');
  // A full replay of lines already recorded is answered before the session's state is judged (the table may have been paid since).
  const known = await posV2Repo.getLinesByIds(tx, actor.orgId, input.storeId, (input.lines ?? []).map((l) => String(l.lineId)));
  if (known.length === (input.lines ?? []).length && known.length > 0) {
    await writeLines(tx, actor, { storeId: input.storeId, pairingId }, session, input.lines); // checks sameness only; nothing fresh to write
    return { wrote: false };
  }
  assertOpen(session);
  const { written, inputs } = await writeLines(tx, actor, { storeId: input.storeId, pairingId }, session, input.lines);
  if (inputs === 0) return { wrote: false };
  const at = deviceTime(input.lines[0]!.addedAtDevice, 'The time of the order');
  await audit(tx, actor, 'pos.lines_added', { storeId: input.storeId, entityId: sessionId, pairingId, at, after: { lines: lineAudit(written) } });
  await posV2Repo.bumpStateVersion(tx, actor.orgId, input.storeId);
  return { wrote: true };
}

// ---------------------------------------------------------------------------------------------------------------------
// R5 heads - and the package line that follows them
// ---------------------------------------------------------------------------------------------------------------------
const PACKAGE_SERVED = 'The package was already served. Void the stand or keep the heads.';

/**
 * T-527b: lines are ordered by (addedAtDevice, addedAt, id) in the database and (addedAtDevice, id) on the tablet. A re-made head line keeps the replaced line's
 * addedAtDevice and addedAt, and, when that id is a device UUIDv7 (millisecond + counter), keeps its leading part too, so it stays in the same place among lines of the same event.
 */
function sameSpotId(old: string): string | undefined {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/i.test(old) ? old.slice(0, 18).toLowerCase() + randomUUID().slice(18) : undefined;
}

/**
 * The billed heads changed from `before` to `after`. The package line(s) follow (rulings 1 and 2): nothing served - the queued package lines are
 * cancelled (their discounts removed with them) and re-made at the new heads at the SAME prices; a served package line stays and an INCREASE
 * adds a new package line for the difference; a DECREASE is refused while any package line is served.
 */
async function followHeads(tx: Tx, actor: Actor, ctx: { storeId: string; pairingId: string | null }, session: SessionRow, before: number, after: number, at: Date): Promise<void> {
  if (before === after) return;
  const live = await loadLiveLines(tx, actor.orgId, ctx.storeId, session.id);
  const pkg = live.filter((l) => l.kind === 'package');
  if (pkg.length === 0) return;
  if (new Set(pkg.map((l) => l.menuItemVariantId)).size > 1) {
    throw refuse('pos: several packages', 'This table has more than one package. Void the stand or keep the heads.');
  }
  const covered = pkg.reduce((a, l) => a + (l.bundleHeads ?? l.qty), 0);
  const served = pkg.some((l) => l.kitchenStatus === 'served');
  if (served && after < covered) throw refuse('pos: package served, heads decreased', PACKAGE_SERVED);
  // Audit F2: seniors and PWDs on the package are guests at the table: never more of them than the new heads.
  const statutoryOnPackage = pkg.flatMap((l) => l.discounts).filter((d) => d.kind === 'senior' || d.kind === 'pwd').reduce((a, d) => a + d.qty, 0);
  if (after < before && statutoryOnPackage > after) {
    throw refuse('pos: more seniors than the new heads', 'Remove a senior/PWD discount first: there would be more senior/PWD guests than heads.');
  }

  // The template: the head price (a per-head line) or the bundle with its extra-head price.
  const bundle = pkg.find((l) => l.bundleHeads !== null && l.bundleHeads > 1);
  const perHead = pkg.find((l) => l.bundleHeads === null);
  let extraUnit: string | null = null;
  if (bundle) {
    extraUnit = perHead?.unitPrice ?? null; // in a bundle session the other package lines (no bundle_heads) are the extra-head lines
    if (extraUnit === null && after > bundle.bundleHeads!) {
      const m = await loadStoreMenu(tx, actor.orgId, ctx.storeId, at);
      const offer = m.menu.items.flatMap((i) => i.variants).find((v) => v.id === bundle.menuItemVariantId)?.channels.store;
      extraUnit = offer && offer.orderable ? offer.extraHeadAmount : null;
      if (extraUnit === null) throw refuse('pos: no extra-head amount', 'There is no price for extra heads here yet.');
    }
  }
  const mk = (from: (typeof pkg)[number], qty: number, unit: Money, name: string, id?: string, place?: { addedAtDevice: Date; addedAt: Date }): posV2Repo.NewSessionLine => ({
    id: id ?? randomUUID(),
    orgId: actor.orgId,
    storeId: ctx.storeId,
    sessionId: session.id,
    kind: 'package',
    menuItemId: from.menuItemId,
    menuItemVariantId: from.menuItemVariantId,
    name,
    qty,
    unitPrice: unit,
    bundleHeads: null,
    optionValueIds: from.optionValueIds,
    kitchenStationId: from.kitchenStationId,
    note: from.note,
    addedBy: actor.personId,
    addedOnPairingId: ctx.pairingId,
    addedAtDevice: place?.addedAtDevice ?? at,
    ...(place ? { addedAt: place.addedAt } : {}),
  });
  const extraName = bundle ? `${bundle.name} - extra head` : '';
  const fresh: posV2Repo.NewSessionLine[] = [];
  let cancelled: string[] = [];
  if (!served) {
    // Re-make: a per-head line is replaced whole; a bundle line stays (its price covers N heads) and only the extra-head line follows.
    cancelled = pkg.filter((l) => l.id !== bundle?.id).map((l) => l.id);
    if (bundle) {
      if (after > bundle.bundleHeads!) fresh.push(mk(bundle, after - bundle.bundleHeads!, money(extraUnit!), extraName));
    } else {
      // T-527b: the re-made head line keeps the replaced line's place in the order (addedAtDevice, addedAt, id), so the table's list does not reshuffle.
      fresh.push(mk(perHead!, after, money(perHead!.unitPrice), perHead!.name, sameSpotId(perHead!.id), perHead!));
    }
  } else {
    const diff = after - covered; // > 0 here (a decrease was refused above)
    if (diff > 0) fresh.push(bundle ? mk(bundle, diff, money(extraUnit!), extraName) : mk(perHead!, diff, money(perHead!.unitPrice), perHead!.name));
  }
  const toRemove = live.filter((l) => cancelled.includes(l.id)).flatMap((l) => l.discounts.map((d) => d.id));
  await posV2Repo.removeLineDiscounts(tx, actor.orgId, ctx.storeId, toRemove, actor.personId, at);
  await posV2Repo.markLinesCancelled(tx, actor.orgId, ctx.storeId, cancelled);
  await posV2Repo.insertLines(tx, fresh);
}

async function changeHeads(
  tx: Tx,
  actor: Actor,
  input: { storeId: string; pairingId: string | null; sessionId: string },
  pairingId: string | null,
  change: { headsCashier?: number; headsServer?: number },
): Promise<{ wrote: boolean }> {
  const sessionId = uuidInput(input.sessionId, 'The table id');
  const session = await lockOpenSession(tx, actor.orgId, input.storeId, sessionId);
  const before = billedHeads(session.headsCashier, session.headsServer);
  const next = { headsCashier: change.headsCashier ?? session.headsCashier, headsServer: change.headsServer ?? session.headsServer };
  if (next.headsCashier === session.headsCashier && next.headsServer === session.headsServer) return { wrote: false };
  const after = billedHeads(next.headsCashier, next.headsServer);
  const at = new Date();
  await followHeads(tx, actor, { storeId: input.storeId, pairingId }, session, before, after, at);
  await posV2Repo.setSessionHeads(tx, actor.orgId, input.storeId, sessionId, change);
  await audit(tx, actor, 'pos.heads_changed', {
    storeId: input.storeId, entityId: sessionId, pairingId, at,
    before: { headsCashier: session.headsCashier, headsServer: session.headsServer, billed: before },
    after: { headsCashier: next.headsCashier, headsServer: next.headsServer, billed: after },
  });
  await posV2Repo.bumpStateVersion(tx, actor.orgId, input.storeId);
  return { wrote: true };
}

export async function confirmHeads(tx: Tx, actor: Actor, input: { storeId: string; pairingId: string | null; sessionId: string; headsServer: number }): Promise<{ wrote: boolean }> {
  await authorize(tx, actor, 'confirm_pos_heads', { storeId: input.storeId });
  const pairingId = await requireContext(tx, actor, input.storeId, input.pairingId, true);
  const headsServer = wholeNumber(input.headsServer, { what: 'The number of guests', min: 1, max: HEADS_MAX });
  return changeHeads(tx, actor, input, pairingId, { headsServer });
}

export async function setHeadsCashier(tx: Tx, actor: Actor, input: { storeId: string; pairingId: string | null; sessionId: string; headsCashier: number }): Promise<{ wrote: boolean }> {
  await authorize(tx, actor, 'record_sale', { storeId: input.storeId });
  const pairingId = await requireContext(tx, actor, input.storeId, input.pairingId, false);
  const sessionId = uuidInput(input.sessionId, 'The table id');
  const mode = (await posV2Repo.getTableSession(tx, actor.orgId, input.storeId, sessionId))?.mode;
  const headsCashier = wholeNumber(input.headsCashier, { what: 'The number of guests', min: mode === 'take_out' ? 0 : 1, max: HEADS_MAX });
  return changeHeads(tx, actor, input, pairingId, { headsCashier });
}

// ---------------------------------------------------------------------------------------------------------------------
// R5 refills, serving, cancelling
// ---------------------------------------------------------------------------------------------------------------------
export async function requestRefill(
  tx: Tx,
  actor: Actor,
  input: { storeId: string; pairingId: string | null; sessionId: string; lines: { lineId: string; menuItemId: string; qty: number; addedAtDevice: string | Date }[] },
): Promise<{ wrote: boolean }> {
  await authorize(tx, actor, 'request_pos_refill', { storeId: input.storeId });
  const pairingId = await requireContext(tx, actor, input.storeId, input.pairingId, true);
  const sessionId = uuidInput(input.sessionId, 'The table id');
  if (!Array.isArray(input.lines) || input.lines.length < 1 || input.lines.length > 100) throw refuse('pos: bad line count', 'Ask for between 1 and 100 refills at a time.');
  const shaped = input.lines.map((l) => ({ l, ...checkLineShape({ ...l, note: undefined }) }));
  const existing = new Map((await posV2Repo.getLinesByIds(tx, actor.orgId, input.storeId, shaped.map((s) => s.lineId))).map((r) => [r.id, r]));
  const sameRefill = (s: (typeof shaped)[number], prior: posV2Repo.TableSessionLineRow) =>
    prior.sessionId === sessionId && prior.kind === 'refill' && prior.menuItemId === s.l.menuItemId && prior.qty === s.qty;
  // Audit F6: a full replay is answered before the table's state is judged (it may have been paid since).
  if (shaped.every((s) => existing.has(s.lineId))) {
    if (shaped.some((s) => !sameRefill(s, existing.get(s.lineId)!))) throw recordedDifferently();
    return { wrote: false };
  }
  await lockOpenSession(tx, actor.orgId, input.storeId, sessionId);
  const live = await loadLiveLines(tx, actor.orgId, input.storeId, sessionId);
  const packageVariants = new Set(live.filter((l) => l.kind === 'package').map((l) => l.menuItemVariantId));
  const menus = new MenuAt(tx, actor.orgId, input.storeId);
  const rows: posV2Repo.NewSessionLine[] = [];
  for (const s of shaped) {
    const prior = existing.get(s.lineId);
    if (prior) {
      if (!sameRefill(s, prior)) throw recordedDifferently();
      continue;
    }
    if (packageVariants.size === 0) throw refuse('pos: refill without a package', 'This table has no package to refill.');
    const menu = await menus.at(s.at);
    const allowed = new Set(menu.menu.items.flatMap((i) => i.variants).filter((v) => packageVariants.has(v.id)).flatMap((v) => v.refillItemIds));
    const { item, variant } = offerFor(menu, s.l.menuItemId, undefined);
    if (item.itemType !== 'refill' || !allowed.has(item.id)) throw refuse('pos: not a refill of the package', `${item.name} is not a refill of this table's package.`);
    rows.push({
      id: s.lineId, orgId: actor.orgId, storeId: input.storeId, sessionId, kind: 'refill', menuItemId: item.id, menuItemVariantId: variant.id,
      name: item.name, qty: s.qty, unitPrice: money('0'), bundleHeads: null, optionValueIds: [], kitchenStationId: item.stationId, note: null, addedBy: actor.personId, addedOnPairingId: pairingId, addedAtDevice: s.at,
    });
  }
  if (rows.length === 0) return { wrote: false };
  await posV2Repo.insertLines(tx, rows);
  await audit(tx, actor, 'pos.refill_requested', { storeId: input.storeId, entityId: sessionId, pairingId, at: rows[0]!.addedAtDevice as Date, after: { lines: lineAudit(rows) } });
  await posV2Repo.bumpStateVersion(tx, actor.orgId, input.storeId);
  return { wrote: true };
}

export async function serveLine(tx: Tx, actor: Actor, input: { storeId: string; pairingId: string | null; lineId: string; servedAtDevice: string | Date }): Promise<{ wrote: boolean }> {
  await authorize(tx, actor, 'serve_pos_ticket', { storeId: input.storeId });
  const pairingId = await requireContext(tx, actor, input.storeId, input.pairingId, true);
  const at = deviceTime(input.servedAtDevice, 'The serving time');
  const line = await posV2Repo.getLine(tx, actor.orgId, input.storeId, uuidInput(input.lineId, 'The line id'));
  if (!line) throw gone('pos: line not found', 'line');
  if (line.kitchenStatus === 'served') return { wrote: false };
  if (line.kitchenStatus === 'cancelled') throw refuse('pos: line cancelled', 'That line was cancelled.');
  await posV2Repo.markLineServed(tx, actor.orgId, input.storeId, line.id, actor.personId, at);
  await audit(tx, actor, 'pos.line_served', { storeId: input.storeId, entityId: line.id, pairingId, at, before: { status: 'queued' }, after: { status: 'served', name: line.name, qty: line.qty } });
  await posV2Repo.bumpStateVersion(tx, actor.orgId, input.storeId);
  return { wrote: true };
}

export async function cancelLine(tx: Tx, actor: Actor, input: { storeId: string; pairingId: string | null; lineId: string; reason: string }): Promise<{ wrote: boolean }> {
  await authorize(tx, actor, 'record_sale', { storeId: input.storeId });
  const pairingId = await requireContext(tx, actor, input.storeId, input.pairingId, false);
  const { reason } = assertFieldRules(POS_REASON_RULES, { reason: input.reason });
  const line = await posV2Repo.getLine(tx, actor.orgId, input.storeId, uuidInput(input.lineId, 'The line id'));
  if (!line) throw gone('pos: line not found', 'line');
  if (line.kitchenStatus === 'cancelled') return { wrote: false }; // Audit F6: a replay is answered before the table's state is judged
  await lockOpenSession(tx, actor.orgId, input.storeId, line.sessionId);
  if (line.kitchenStatus === 'served') throw refuse('pos: line served', 'That line was already served and cannot be cancelled.');
  await posV2Repo.markLinesCancelled(tx, actor.orgId, input.storeId, [line.id]);
  await audit(tx, actor, 'pos.line_cancelled', { storeId: input.storeId, entityId: line.id, pairingId, at: new Date(), before: { status: 'queued', name: line.name, qty: line.qty }, after: { status: 'cancelled', reason } });
  await posV2Repo.bumpStateVersion(tx, actor.orgId, input.storeId);
  return { wrote: true };
}
