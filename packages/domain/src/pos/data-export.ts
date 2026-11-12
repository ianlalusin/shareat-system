/**
 * T-569 - the POS v2 data download. docs/tasks/569-pos-data-download.md.
 *
 * One table, one store, one date range, as text (a copy, never a report: no figure is recomputed or formatted). The whole check lives HERE, beside
 * the read, so the route cannot skip it (a read has no other choke point): a store is required (no org-wide file), `view_financial_reports` is proven
 * at that store, the range is valid, and the table is one we export. Only then is the read made and the `data.export_downloaded` row written, in the
 * SAME transaction, before the caller builds any response.
 */
import { randomUUID } from 'node:crypto';
import { authorize, type Actor } from '@shareat/auth';
import { addDays, parseBusinessDate } from '@shareat/core/datetime';
import { auditLogRepo, posV2Repo, type Tx } from '@shareat/db';
import { refuse } from '../shared/refusal';
import { readRules, uuidInput, type PosDeps } from './shared';

/**
 * shortcut: a technical cap on the size of one file, not a business setting; raise it here only if a file stops opening in Excel. 62 days covers December with margin.
 */
export const POS_EXPORT_MAX_DAYS = 62;

export interface PosDataExport {
  table: posV2Repo.PosExportTable;
  columns: string[];
  rows: Record<string, string | null>[];
  /** `pos-<storecode>-<table>-<from>-to-<to>.csv` */
  filename: string;
}

function isDate(v: unknown): v is string {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  try {
    return parseBusinessDate(v) === v;
  } catch {
    return false;
  }
}

export async function exportPosData(
  tx: Tx,
  actor: Actor,
  input: { storeId?: string | null; from?: string | null; to?: string | null; table?: string | null },
  deps?: PosDeps,
): Promise<PosDataExport> {
  if (!input.storeId) throw refuse('pos export: no store', 'Choose one store. A download is for one store at a time.');
  const storeId = uuidInput(input.storeId, 'The store');
  await authorize(tx, actor, 'view_financial_reports', { storeId });

  const { from, to, table } = input;
  if (!isDate(from) || !isDate(to)) throw refuse('pos export: bad date', 'Choose a from date and a to date.');
  if (from.localeCompare(to) > 0) throw refuse('pos export: from after to', 'The from date is after the to date.');
  if (addDays(parseBusinessDate(from), POS_EXPORT_MAX_DAYS - 1).localeCompare(to) < 0) {
    throw refuse('pos export: range too long', `Choose at most ${POS_EXPORT_MAX_DAYS} days at a time.`);
  }
  const known = posV2Repo.POS_EXPORT_TABLES.find((t) => t === table);
  if (!known) throw refuse('pos export: unknown table', 'That file is not one we offer.');

  const code = await posV2Repo.getStoreCode(tx, actor.orgId, storeId);
  if (!code) throw refuse('pos export: unknown store', 'Choose one store. A download is for one store at a time.');
  // The business-day start hour (pos.business_day_start_hour) dates a receipt or session that has no Z yet, as T-531 does.
  // shortcut: one hour for the whole range, read on its last date; a rule change inside a 62-day range could move a boundary receipt, only until its Z exists.
  const { businessDayStartHour } = await readRules(tx, actor.orgId, to, deps);
  const { columns, rows } = await posV2Repo.exportRowsForStore(tx, actor.orgId, storeId, from, to, known, businessDayStartHour);
  await auditLogRepo.append(tx, actor.orgId, {
    actorPersonId: actor.personId,
    action: 'data.export_downloaded',
    // The catalogue entry is org-scoped (store_id must be null): the store is named in the details.
    storeId: null,
    entityId: randomUUID(),
    before: null,
    after: { kind: 'pos_data', table: known, storeId, from, to, rowCount: rows.length },
    source: 'web',
  });
  // The code goes into a quoted Content-Disposition header: keep only letters, digits and hyphens (an empty result falls back to the store id).
  const safeCode = code.replace(/[^A-Za-z0-9-]/g, '').toLowerCase() || storeId;
  return { table: known, columns, rows, filename: `pos-${safeCode}-${known}-${from}-to-${to}.csv` };
}
