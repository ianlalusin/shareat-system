/**
 * T-546 R2 - the tills of a store: add one, choose which paired tablet acts as it, set its receipt printer. docs/tasks/546-pos-terminal-printer-settings.md.
 *
 * A till (`pos_terminals`) is the stable receipt-number identity (DEF-587); the tablet acting as it can be replaced. The printer settings live on the till,
 * so a replaced tablet inherits them. A till is never deleted (its receipts reference it): un-linking the tablet is the only way to retire its tablet.
 *
 * Every function is `(tx, actor, input)` and calls `authorize` FIRST: `pair_pos_tablet` (admin, manager; staff never) at the STORE, so a manager of another
 * store is refused. (`provision_clock_terminal`, which the page route uses, is admin-only; the spec's "a store manager succeeds" needs this word. The
 * page's own gate is unchanged.) Each change is audited with before and after and bumps `pos_stores.state_version`, when the store has that row, so the
 * tablets refresh their snapshot (which carries the printer settings, R3).
 */
import { auditLogRepo, posV2Repo, type Tx } from '@shareat/db';
import { authorize, type Actor } from '@shareat/auth';
import { gone, refuse } from '../shared/refusal';
import { uuidInput, wholeNumber } from './shared';

const CAPABILITY = 'pair_pos_tablet' as const;

export type TillView = posV2Repo.TillRow;
export interface TerminalList {
  readonly terminals: TillView[];
  /** The store's live tablets that act as no till yet: the ones a manager may choose. */
  readonly freePairings: { id: string; label: string }[];
}

async function bump(tx: Tx, orgId: string, storeId: string): Promise<void> {
  if (await posV2Repo.getPosStore(tx, orgId, storeId)) await posV2Repo.bumpStateVersion(tx, orgId, storeId);
}

export async function listTerminals(tx: Tx, actor: Actor, input: { storeId: string }): Promise<TerminalList> {
  await authorize(tx, actor, CAPABILITY, { storeId: input.storeId });
  return {
    terminals: await posV2Repo.listTillsForStore(tx, actor.orgId, input.storeId),
    freePairings: await posV2Repo.listFreeLivePairings(tx, actor.orgId, input.storeId),
  };
}

export async function createTerminal(tx: Tx, actor: Actor, input: { storeId: string; terminalNo: unknown }): Promise<{ terminalId: string }> {
  await authorize(tx, actor, CAPABILITY, { storeId: input.storeId });
  const terminalNo = wholeNumber(input.terminalNo, { what: 'The till number', min: 1, max: 99 });
  if (await posV2Repo.getTerminalByNo(tx, actor.orgId, input.storeId, terminalNo)) {
    throw refuse(`createTerminal: till ${terminalNo} exists at store ${input.storeId}`, `Till ${terminalNo} already exists at this store.`);
  }
  const row = await posV2Repo.insertTill(tx, { orgId: actor.orgId, storeId: input.storeId, terminalNo, createdBy: actor.personId });
  await auditLogRepo.append(tx, actor.orgId, {
    actorPersonId: actor.personId,
    action: 'pos.terminal_created',
    storeId: input.storeId,
    entityId: row.id,
    before: null,
    after: { terminalNo, pairingId: null, receiptPaperMm: row.receiptPaperMm, receiptCopies: row.receiptCopies },
    source: 'web',
  });
  await bump(tx, actor.orgId, input.storeId);
  return { terminalId: row.id };
}

export async function linkTerminal(tx: Tx, actor: Actor, input: { storeId: string; terminalId: string; pairingId: string | null }): Promise<{ terminalId: string; wrote: boolean }> {
  await authorize(tx, actor, CAPABILITY, { storeId: input.storeId });
  const terminalId = uuidInput(input.terminalId, 'That till');
  const pairingId = input.pairingId === null ? null : uuidInput(input.pairingId, 'That tablet');
  const till = await posV2Repo.getTillForUpdate(tx, actor.orgId, input.storeId, terminalId);
  if (!till) throw gone(`linkTerminal: till ${terminalId} not in store ${input.storeId}`, 'till');
  if (pairingId !== null) {
    if (!(await posV2Repo.getLivePairing(tx, actor.orgId, input.storeId, pairingId))) {
      throw refuse(`linkTerminal: pairing ${pairingId} is not a live pairing of store ${input.storeId}`, 'That tablet is not paired to this store.');
    }
    const holder = await posV2Repo.getTerminalForPairing(tx, actor.orgId, input.storeId, pairingId);
    if (holder && holder.id !== terminalId) {
      throw refuse(`linkTerminal: pairing ${pairingId} already acts as till ${holder.terminalNo}`, `That tablet already acts as till ${holder.terminalNo}.`);
    }
  }
  // Nothing changes: no write, no audit row, no state_version bump (the tablets would refresh for nothing).
  if (till.pairingId === pairingId) return { terminalId, wrote: false };
  await posV2Repo.setTillPairing(tx, actor.orgId, input.storeId, terminalId, pairingId);
  await auditLogRepo.append(tx, actor.orgId, {
    actorPersonId: actor.personId,
    action: 'pos.terminal_linked',
    storeId: input.storeId,
    entityId: terminalId,
    before: { terminalNo: till.terminalNo, pairingId: till.pairingId },
    after: { terminalNo: till.terminalNo, pairingId },
    source: 'web',
  });
  await bump(tx, actor.orgId, input.storeId);
  return { terminalId, wrote: true };
}

export async function setTerminalPrinter(
  tx: Tx,
  actor: Actor,
  input: { storeId: string; terminalId: string; receiptPaperMm: unknown; receiptCopies: unknown },
): Promise<{ terminalId: string; wrote: boolean }> {
  await authorize(tx, actor, CAPABILITY, { storeId: input.storeId });
  const terminalId = uuidInput(input.terminalId, 'That till');
  if (input.receiptPaperMm !== 58 && input.receiptPaperMm !== 80) throw refuse('setTerminalPrinter: paper is not 58 or 80', 'Paper width must be 58 mm or 80 mm.');
  const receiptPaperMm: number = input.receiptPaperMm;
  const receiptCopies = wholeNumber(input.receiptCopies, { what: 'Copies', min: 1, max: 3 });
  const till = await posV2Repo.getTillForUpdate(tx, actor.orgId, input.storeId, terminalId);
  if (!till) throw gone(`setTerminalPrinter: till ${terminalId} not in store ${input.storeId}`, 'till');
  if (till.receiptPaperMm === receiptPaperMm && till.receiptCopies === receiptCopies) return { terminalId, wrote: false }; // same values: nothing to write or audit
  await posV2Repo.setTillPrinter(tx, actor.orgId, input.storeId, terminalId, receiptPaperMm, receiptCopies);
  await auditLogRepo.append(tx, actor.orgId, {
    actorPersonId: actor.personId,
    action: 'pos.terminal_printer_set',
    storeId: input.storeId,
    entityId: terminalId,
    before: { terminalNo: till.terminalNo, receiptPaperMm: till.receiptPaperMm, receiptCopies: till.receiptCopies },
    after: { terminalNo: till.terminalNo, receiptPaperMm, receiptCopies },
    source: 'web',
  });
  await bump(tx, actor.orgId, input.storeId);
  return { terminalId, wrote: true };
}
