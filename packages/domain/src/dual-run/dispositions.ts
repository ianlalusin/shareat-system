/**
 * Recording a dual-run disposition - T-392 S5 (R10, invariants 45-48; Ian's ruling 2026-10-13).
 * docs/tasks/392-dual-run-comparator.md "S5 spec (refinements)" and "Ian rulings, 2026-10-13".
 *
 * A disposition is a person's statement about one delta: V1_DEFECT or V2_DEFECT, with a DEF-nnn ref and a note.
 * It is append-only and takes effect only at the next compare run (the comparator reads dispositions, never this file).
 *
 * Who may record (all three, checked HERE, never only in the UI):
 *  - `run_cutover` (org-scoped; managers hold it by default),
 *  - `view_financial_reports` AT THE LINE'S STORE (nobody dispositions a line they may not see),
 *  - an active role of `admin` or `super_admin` (Ian: managers see the pages read-only).
 * Any of these failing throws AuthorizationError before anything is read or written.
 *
 * The delta is never an input: `delta_at` is the CURRENT version's line delta, read from the database, so a stale
 * page cannot assert an amount (invariant 46).
 *
 * ⛔ Exported from `packages/domain/src/index.ts` directly and NEVER from `dual-run/index.ts`: the `dual-run` CLI imports
 * that barrel and has no `classify` subcommand (R10); the writer is reachable only from the server action.
 */
import { authorize, AuthorizationError, canAt, heldCapabilities, type Actor } from '@shareat/auth';
import { money, toCentavos } from '@shareat/core/money';
import { refuse } from '../shared/refusal';
import { accessRepo, advisoryLocksRepo, auditLogRepo, dualRunReadsRepo, dualRunRepo, schema, type Tx } from '@shareat/db';

export type DualRunKindName = (typeof schema.DUAL_RUN_KINDS)[number];

export const DISPOSITION_CLASS_OPTIONS = ['V1_DEFECT', 'V2_DEFECT'] as const;
export type DispositionClassName = (typeof DISPOSITION_CLASS_OPTIONS)[number];

/** Classes the comparator settles before dispositions: a row against such a line would be dead (compare.ts). */
const SETTLED_CLASSES: ReadonlySet<string> = new Set(['TIES', 'INVENTORY_BASIS', 'SUPPLIER_ADVANCE_1240', 'UNMAPPED_KEY']);

const REF_PATTERN = /^DEF-[0-9]+$/;
const WEEK_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export interface RecordDualRunDispositionInput {
  storeId: string;
  weekStart: string;
  kind: DualRunKindName;
  lineKey: string;
  class: DispositionClassName;
  ref: string;
  note: string;
}

/**
 * Whether a person could record against this line: a non-zero delta that the comparator has not already settled.
 * One definition, used by the writer and by the page that decides whether to draw the form (the page's answer is a
 * hint; this function's refusal in the writer is the gate).
 */
export function isDispositionableLine(line: { kind: string; lineKey: string; class: string; delta: string }): boolean {
  if (toCentavos(money(line.delta)) === 0n) return false;
  if (SETTLED_CLASSES.has(line.class)) return false;
  if (line.kind === 'sales_tender' && line.lineKey === 'none') return false;
  return true;
}

/**
 * A non-throwing yes/no for the page: would `recordDualRunDisposition` pass its gate for this store? The same three
 * conditions, asked once. A HINT for drawing the form; the writer's own gate is the authority.
 */
export async function mayRecordDualRunDisposition(tx: Tx, actor: Actor, storeId: string): Promise<boolean> {
  const role = await accessRepo.activeRoleForPerson(tx, actor.personId, actor.orgId);
  if (!role || (role.role !== 'admin' && role.role !== 'super_admin')) return false;
  if (!(await heldCapabilities(tx, actor)).has('run_cutover')) return false;
  return canAt(tx, actor.personId, 'view_financial_reports', storeId);
}

const NOT_ADMIN_SENTENCE = 'Only an administrator can record a disposition. Managers can read this page but not change it.';

export async function recordDualRunDisposition(
  tx: Tx,
  actor: Actor,
  input: RecordDualRunDispositionInput,
): Promise<{ id: string; deltaAt: string }> {
  // (1) the gate: capability, capability at the line's store, then the role. Nothing is read from the report first.
  await authorize(tx, actor, 'run_cutover', {});
  await authorize(tx, actor, 'view_financial_reports', { storeId: input.storeId });
  const role = await accessRepo.activeRoleForPerson(tx, actor.personId, actor.orgId);
  if (!role || (role.role !== 'admin' && role.role !== 'super_admin')) {
    throw new AuthorizationError(
      `recordDualRunDisposition: role ${role?.role ?? 'none'} is not admin or super_admin`,
      'run_cutover',
      NOT_ADMIN_SENTENCE,
    );
  }

  // (2) the input, before any read of a report.
  if (!(DISPOSITION_CLASS_OPTIONS as readonly string[]).includes(input.class)) {
    throw refuse(`recordDualRunDisposition: class ${String(input.class)} is not V1_DEFECT or V2_DEFECT`, 'A disposition says whose defect it is: the old system (V1_DEFECT) or the new one (V2_DEFECT).');
  }
  if (!REF_PATTERN.test(input.ref)) throw refuse(`recordDualRunDisposition: ref ${String(input.ref)} is not DEF-nnn`, 'The defect reference must look like DEF-123.');
  const note = typeof input.note === 'string' ? input.note.trim() : '';
  if (note.length < 1 || note.length > 500) throw refuse('recordDualRunDisposition: note must be 1-500 characters', 'The note is required and may be at most 500 characters.');
  if (!(schema.DUAL_RUN_KINDS as readonly string[]).includes(input.kind)) throw refuse(`recordDualRunDisposition: unknown kind ${String(input.kind)}`, 'That kind of line does not exist.');
  if (typeof input.weekStart !== 'string' || !WEEK_PATTERN.test(input.weekStart)) throw refuse('recordDualRunDisposition: weekStart is not a date', 'The week must be a date.');
  if (typeof input.lineKey !== 'string' || input.lineKey === '') throw refuse('recordDualRunDisposition: lineKey is empty', 'Choose the line to record against.');

  // The same per-store-week lock `compare --apply` takes: a disposition cannot interleave with a run's read of it.
  await advisoryLocksRepo.lockDualRunWeek(tx, actor.orgId, input.storeId, input.weekStart);

  // (3) the CURRENT version of the store-week and its line.
  const [current] = await dualRunReadsRepo.reportVersions(tx, actor.orgId, input.storeId, input.weekStart);
  if (!current) throw refuse('recordDualRunDisposition: no report for the store-week', 'There is no compare report for that store and week.');
  const lines = await dualRunRepo.linesOf(tx, current.id);
  const line = lines.find((l) => l.kind === input.kind && l.lineKey === input.lineKey);
  if (!line) throw refuse('recordDualRunDisposition: line not in the current report', 'That line is not in the current report for the store and week.');
  if (toCentavos(money(line.delta)) === 0n) throw refuse('recordDualRunDisposition: line delta is zero', 'That line already ties; there is nothing to record.');
  if (SETTLED_CLASSES.has(line.class)) {
    throw refuse(
      `recordDualRunDisposition: line is settled as ${line.class}`,
      `The comparator settles that line as ${line.class}; a disposition cannot change it.`,
    );
  }
  if (line.kind === 'sales_tender' && line.lineKey === 'none') {
    throw refuse('recordDualRunDisposition: sales_tender none line is settled', 'The comparator settles that line as NOT_DOUBLE_ENTERED; a disposition cannot change it.');
  }

  // (4) the delta is the database's, never the caller's.
  const deltaAt = money(line.delta);

  // (5) the row, then (6) the audit entry.
  const { id } = await dualRunRepo.insertDisposition(tx, {
    orgId: actor.orgId,
    storeId: input.storeId,
    weekStart: input.weekStart,
    kind: input.kind,
    lineKey: input.lineKey,
    deltaAt,
    class: input.class,
    ref: input.ref,
    note,
    createdBy: actor.personId,
  });
  await auditLogRepo.append(tx, actor.orgId, {
    actorPersonId: actor.personId,
    action: 'dual_run.disposition',
    storeId: input.storeId,
    entityId: id,
    before: null,
    after: {
      weekStart: input.weekStart,
      kind: input.kind,
      lineKey: input.lineKey,
      class: input.class,
      ref: input.ref,
      deltaAt,
      reportId: current.id,
    },
    source: 'web',
  });
  return { id, deltaAt };
}
