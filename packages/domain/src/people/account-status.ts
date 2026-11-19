/**
 * T-612 (Ian, 19 Nov 2026) - a person's ACCOUNT STATUS: activate, suspend, reinstate. docs/tasks/612-staff-account-status.md.
 *
 * pending (hired, waiting) -> activate -> active <-> suspend / reinstate <-> suspended.  `ended` is reached only by T-609's `endEmployment`
 * (the person's last open job) and left only by a re-hire (`createEmployment`, which sets `pending`). Suspending is "A": role, store scope and grants
 * are KEPT (paused), only sign-in and the sessions already open are switched off; reinstating restores everything exactly.
 *
 * Who may act (decided here, inside the domain, after the org lock and the role read):
 *  - the target holds `staff` (or no role): `enrol_staff` at the employment's store, so a store manager can;
 *  - the target is a manager, admin or super_admin: `manage_users` (administrators) AND the rank rule - nobody acts on someone who outranks them;
 *  - nobody suspends themself; the organisation's last administrator who can sign in cannot be suspended.
 * Lock order (shared with sign-in and `endEmployment`, so none of them can deadlock): persons -> employments -> org advisory lock.
 */
import { authorize, holdsSuperAdminAuthority, isAdministrative, isStoreManagerOrAbove, type Actor } from '@shareat/auth';
import { accessRepo, auditLogRepo, employmentRepo, personsRepo, sessionsRepo, type EmploymentRow, type Tx } from '@shareat/db';
import type { AccountStatus } from '@shareat/db/schema';
import { EmploymentError } from './index';

type Move = 'activate' | 'suspend' | 'reinstate';

const MOVES: Record<Move, { from: AccountStatus; to: AccountStatus }> = {
  activate: { from: 'pending', to: 'active' },
  suspend: { from: 'active', to: 'suspended' },
  reinstate: { from: 'suspended', to: 'active' },
};

const MAX_REASON = 500;

/** The sentence for a person who is not in the state the button needs (the page normally hides the button, so this is a lost race or a forged post). */
function wrongState(move: Move, status: AccountStatus): EmploymentError {
  const why: Record<AccountStatus, string> = {
    pending: 'This account has not been activated yet.',
    active: 'This account is already active.',
    suspended: 'This account is suspended. Use Reinstate to restore it.',
    ended: 'Access ended. Hire again to restore it.',
  };
  return new EmploymentError(`${move}: account status is '${status}', needs '${MOVES[move].from}'`, why[status]);
}

async function changeStatus(tx: Tx, actor: Actor, input: { employmentId: string; reason?: string }, move: Move): Promise<EmploymentRow> {
  const existing = await employmentRepo.getEmployment(tx, input.employmentId);
  if (!existing || existing.orgId !== actor.orgId) throw new EmploymentError(`No employment ${input.employmentId}`);
  const { personId, orgId } = existing;
  const spec = MOVES[move];

  if (move === 'suspend' && actor.personId === personId) {
    throw new EmploymentError('suspend: refusing - an actor may not suspend their own account', 'You can’t suspend your own account. Ask another manager or an administrator.');
  }
  const reason = (input.reason ?? '').trim();
  if (move === 'suspend' && (reason === '' || reason.length > MAX_REASON)) {
    throw new EmploymentError(`suspend: reason must be 1-${MAX_REASON} characters`, `Say why you are suspending this account (up to ${MAX_REASON} characters).`);
  }

  // persons FIRST (queues behind a sign-in holding the row `for share`, and behind another status change), then the org lock, THEN the role read.
  const status = await personsRepo.lockAccountStatus(tx, orgId, personId);
  if (!status) throw new EmploymentError(`No person ${personId}`);
  await accessRepo.lockOrgAccess(tx, orgId);
  const target = (await accessRepo.activeRoleForPerson(tx, personId, orgId))?.role;

  if (!target || target === 'staff') {
    await authorize(tx, actor, 'enrol_staff', { storeId: existing.storeId, orgId });
  } else {
    await authorize(tx, actor, 'manage_users', { orgId });
    const mine = (await accessRepo.activeRoleForPerson(tx, actor.personId, orgId))?.role;
    const may = target === 'super_admin' ? await holdsSuperAdminAuthority(tx, actor, mine) : target === 'admin' ? isAdministrative(mine) : isStoreManagerOrAbove(mine);
    if (!may) {
      throw new EmploymentError(
        `${move}: refusing - person ${personId} holds '${target}', which outranks '${mine ?? 'no role'}'`,
        `This person is ${target === 'manager' ? 'a manager' : 'an administrator'}, so it needs somebody at least as senior as them.`,
      );
    }
  }

  if (status !== spec.from) throw wrongState(move, status);
  if (move === 'suspend' && isAdministrative(target) && !(await accessRepo.hasOtherActiveAdminWhoCanSignIn(tx, orgId, personId))) {
    throw new EmploymentError(
      `suspend: refusing - person ${personId} is the organisation's last administrator who can sign in`,
      'This is the only administrator who can sign in. Appoint another administrator with a PIN first, then suspend this account.',
    );
  }

  if (!(await personsRepo.setAccountStatus(tx, orgId, personId, [spec.from], spec.to))) throw wrongState(move, status);

  // Suspend: every session the person holds ends in THIS transaction (resolveActor trusts a live session, so nothing else would).
  let endedSessions = 0;
  if (move === 'suspend') {
    endedSessions = await sessionsRepo.endAllForPerson(tx, personId, 'revoked');
    if (endedSessions > 0) {
      // Built outside the call: the T-402 S1b static guard reads any `storeId:` inside an append call as the row's store.
      const endedAfter = { reason: 'account_suspended', employmentId: existing.id, storeId: null, ended: endedSessions };
      await auditLogRepo.append(tx, orgId, {
        actorPersonId: actor.personId,
        action: 'session.ended_all',
        storeId: null,
        entityId: personId,
        before: null,
        after: endedAfter,
        source: 'web',
      });
    }
  }

  // One literal call per action: the T-402 S1b build guard reads the action string out of the source.
  const after = move === 'suspend' ? { accountStatus: spec.to, reason, endedSessions } : { accountStatus: spec.to };
  const before = { accountStatus: spec.from };
  if (move === 'activate') {
    await auditLogRepo.append(tx, orgId, {
      actorPersonId: actor.personId,
      action: 'account.activated',
      storeId: existing.storeId,
      entityId: personId,
      before,
      after,
      source: 'web',
    });
  } else if (move === 'suspend') {
    await auditLogRepo.append(tx, orgId, {
      actorPersonId: actor.personId,
      action: 'account.suspended',
      storeId: existing.storeId,
      entityId: personId,
      before,
      after,
      source: 'web',
    });
  } else {
    await auditLogRepo.append(tx, orgId, {
      actorPersonId: actor.personId,
      action: 'account.reinstated',
      storeId: existing.storeId,
      entityId: personId,
      before,
      after,
      source: 'web',
    });
  }
  return existing;
}

/** pending -> active. Allowed with or without a PIN set (the page then says "Set a PIN so they can sign in"). */
export function activateAccount(tx: Tx, actor: Actor, input: { employmentId: string }): Promise<EmploymentRow> {
  return changeStatus(tx, actor, input, 'activate');
}

/** active -> suspended: rights kept (paused), sign-in refused, every open session ended in the same transaction. Needs a reason. */
export function suspendAccount(tx: Tx, actor: Actor, input: { employmentId: string; reason: string }): Promise<EmploymentRow> {
  return changeStatus(tx, actor, input, 'suspend');
}

/** suspended -> active: the same rights as before, no re-setup. */
export function reinstateAccount(tx: Tx, actor: Actor, input: { employmentId: string }): Promise<EmploymentRow> {
  return changeStatus(tx, actor, input, 'reinstate');
}
