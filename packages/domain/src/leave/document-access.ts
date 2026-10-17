/**
 * T-436 S6 - who may OPEN a medical-certificate photo, and the audit rows around it. Spec D14, bible row 353.
 *
 * ⛔ A `leave_document` is read ONLY through this decision (called by `readFileUrl`), never through `canReadFiles` /
 * `PURPOSE_CAPABILITY`, which govern UPLOAD (the capability that lets a manager attach one is not the right to look at one).
 * Same shape as T-434's staff signature.
 *
 * Who may view:
 *  (a) while the request is PENDING: a `manage_attendance` holder at its store who is not the employee;
 *      once DECIDED: only the person who decided (approved / rejected / recorded) it, while still holding `manage_attendance` there;
 *  (b) payroll staff: a `view_leave_document` holder at the store (position-grantable; admin and super_admin hold it by the matrix);
 *  (c) an admin or super_admin.
 * Everyone else - the employee, a colleague, another store's manager, a second store manager after the decision - sees only
 * "proof attached" (a boolean). Links last 60 seconds. Every view is audited; a refused attempt is audited in its OWN transaction so
 * it survives the refusal rolling the caller's back. ⛔ No audit payload carries a file id, path or URL.
 */
import { accessRepo, auditLogRepo, leaveRepo, withOrgPrincipal, type Tx } from '@shareat/db';
import { can, type Actor } from '@shareat/auth';
import { logger } from '@shareat/core/logger';

/** The signed link for a leave document is good for this long, whatever the caller asks for (the `/files` route default is 300). */
export const LEAVE_DOCUMENT_LINK_SECONDS = 60;

export interface LeaveDocumentVerdict {
  readonly allowed: boolean;
  /** The request the file is linked to, if any (for the audit row). */
  readonly requestId: string | null;
  readonly storeId: string | null;
}

export async function decideLeaveDocumentRead(tx: Tx, by: Actor, file: { id: string }): Promise<LeaveDocumentVerdict> {
  const requestId = await leaveRepo.requestOfFile(tx, by.orgId, file.id);
  const request = requestId ? await leaveRepo.getRequest(tx, by.orgId, requestId) : undefined;
  if (!request) return { allowed: false, requestId: null, storeId: null };
  const verdict = (allowed: boolean): LeaveDocumentVerdict => ({ allowed, requestId: request.id, storeId: request.storeId });

  // (c) admins and super_admins.
  const role = await accessRepo.activeRoleForPerson(tx, by.personId, by.orgId);
  if (role?.role === 'admin' || role?.role === 'super_admin') return verdict(true);

  // (b) payroll staff holding the dedicated capability at this store.
  if (await can(tx, by, 'view_leave_document', { storeId: request.storeId })) return verdict(true);

  // (a) the managers: pending - any manage_attendance holder who is not the employee; decided - only the one who decided it.
  if (by.personId !== request.personId && (await can(tx, by, 'manage_attendance', { storeId: request.storeId }))) {
    if (request.status === 'pending') return verdict(true);
    if (request.decidedBy !== null && request.decidedBy === by.personId) return verdict(true);
  }
  return verdict(false);
}

/** One `leave_document.viewed` row, in the viewer's own transaction. The entity is the REQUEST; no file id anywhere. */
export async function recordLeaveDocumentViewed(tx: Tx, by: Actor, verdict: LeaveDocumentVerdict): Promise<void> {
  if (!verdict.requestId || !verdict.storeId) return;
  await auditLogRepo.append(tx, by.orgId, {
    actorPersonId: by.personId,
    action: 'leave_document.viewed',
    storeId: verdict.storeId,
    entityId: verdict.requestId,
    before: null,
    after: { requestId: verdict.requestId },
    source: 'web',
  });
}

/**
 * A refused attempt, written in a SEPARATE transaction: the caller is about to throw (rolling its own transaction back), and the
 * attempt must stay on the record. Never throws - failing to write the evidence must not change what the caller answers.
 */
export async function recordLeaveDocumentViewRefused(actor: Actor, verdict: LeaveDocumentVerdict): Promise<void> {
  if (!verdict.requestId || !verdict.storeId) return;
  const { requestId, storeId } = verdict;
  try {
    await withOrgPrincipal(actor.orgId, (tx) =>
      auditLogRepo.append(tx, actor.orgId, {
        actorPersonId: actor.personId,
        action: 'leave_document.view_refused',
        storeId,
        entityId: requestId,
        before: null,
        after: { requestId },
        source: 'web',
      }),
    );
  } catch (err) {
    logger.error({ kind: 'fault', errorName: err instanceof Error ? err.name : typeof err }, 'leave: could not record a refused certificate view');
  }
}
