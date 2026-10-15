/**
 * T-402 S3 (C4) - the `remittance.recorded` event. Its own file because `remittance/index.ts` declares `action: 'charge'` and
 * `action: 'recognise_income'` as TYPE members, and the action-coverage scan (tests/unit/t402-s1a-action-coverage.test.ts) reads
 * every `action:` line of a file that calls `auditLogRepo.append` as an audit action.
 */
import type { Actor } from '@shareat/auth';
import { auditLogRepo, type Tx } from '@shareat/db';

/** Same transaction as the remittance, written after its own rows (a rollback drops both). Posted on create: no confirm verb. */
export async function recordRemittanceEvent(
  tx: Tx,
  actor: Actor,
  remittance: { id: string; storeId: string; amount: string; remittedOn: string },
): Promise<void> {
  await auditLogRepo.append(tx, actor.orgId, {
    actorPersonId: actor.personId,
    action: 'remittance.recorded',
    storeId: remittance.storeId,
    entityId: remittance.id,
    before: null,
    after: { status: 'posted', amount: remittance.amount, remittedOn: remittance.remittedOn },
    source: 'web',
  });
}
