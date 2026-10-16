/**
 * Server helpers behind the destructive buttons (T-412) - the parts every Tier P / Tier R action shares.
 * docs/tasks/412-confirm-destructive-tiers.md.
 *
 * What stays IN each action, literally, on purpose (apps/erp/tests/t412-destructive-census.test.ts reads the source):
 * the `verifyAdminApproval(` / `retypeMatches(` call, ahead of the domain call, taking the PIN / typed name from the form's
 * one field and the store / name from the RECORD. What lives here: reading the record, and writing the audit row.
 */
import { authorize, can, type Actor, type Capability } from '@shareat/auth';
import { auditLogRepo, destructiveTargetsRepo, goneSentence, refuse, type DestructiveEntity, type DestructiveTarget, type Tx } from '@shareat/db';
import { withOrgPrincipal } from '../app/expenses/lib';
import { retypeRefusal } from './retype';

/**
 * The record behind a button: its store, name and status, read in the action's OWN query (never a form field). Before
 * anything is charged, the actor must hold one of `capabilities` at that store (bible spec order: authorize the actor as
 * today, load the record, verify the PIN, mutate) - so a person who may not do this at all cannot spend the store's PIN
 * attempts by posting forged forms. The domain call that follows still makes its own, unchanged decision.
 */
export async function loadDestructiveTarget(
  actor: Actor,
  entity: DestructiveEntity,
  id: string,
  capabilities: readonly Capability[],
): Promise<DestructiveTarget> {
  return withOrgPrincipal(actor.orgId, async (tx) => {
    const target = await destructiveTargetsRepo.targetOf(tx, actor.orgId, entity, id);
    if (!target) {
      const what = entity.replace(/_/g, ' ');
      throw refuse(`${entity} ${id} does not exist in org ${actor.orgId}`, goneSentence(what));
    }
    const ctx = target.storeId ? { storeId: target.storeId } : {};
    for (const capability of capabilities) {
      if (await can(tx, actor, capability, ctx)) return target;
    }
    // None held: authorize() throws the same refusal the domain would have thrown.
    await authorize(tx, actor, capabilities[0]!, ctx);
    return target;
  });
}

/**
 * The same, for an action whose record has NO store of its own (organisation-level: posting the opening balances, the
 * cutover). Its approval charges the organisation's own PIN bucket (store NULL, migration 0198).
 */
export async function authorizeOrgLevel(actor: Actor, capability: Capability): Promise<void> {
  await withOrgPrincipal(actor.orgId, (tx) => authorize(tx, actor, capability, {}));
}

export interface ApprovalFacts {
  capability: Capability;
  entityType: string;
  entityId: string;
  /** The RECORD's store; null for an organisation-level action. */
  storeId: string | null;
}

/**
 * Writes `destructive.approved` in the caller's transaction - the SAME one as the mutation, so a rollback removes both and an
 * action the domain refused leaves no approval event. Names who acted and who approved; never the PIN.
 */
export async function recordApproval(tx: Tx, actor: Actor, approval: { approverPersonId: string }, facts: ApprovalFacts): Promise<void> {
  await auditLogRepo.append(tx, actor.orgId, {
    actorPersonId: actor.personId,
    action: 'destructive.approved',
    storeId: facts.storeId,
    entityId: facts.entityId,
    before: null,
    after: {
      capability: facts.capability,
      entityType: facts.entityType,
      entityId: facts.entityId,
      actorPersonId: actor.personId,
      approverPersonId: approval.approverPersonId,
    },
    source: 'web',
  });
}

/**
 * ONLY for an action that serves two buttons (an unposted withdraw and a posted void): the server decides which one this is
 * from the record's state, never from the form. This re-reads that state inside the mutation's own transaction, so a record
 * that became posted after the first read (a race) cannot be voided without the approval it now needs.
 */
export async function assertApprovalStillRight(
  tx: Tx,
  actor: Actor,
  entity: DestructiveEntity,
  id: string,
  needsApproval: (status: string | null) => boolean,
  approved: boolean,
): Promise<void> {
  const now = await destructiveTargetsRepo.targetOf(tx, actor.orgId, entity, id);
  if (now && needsApproval(now.status) && !approved) {
    throw refuse(
      `${entity} ${id} became posted after the approval decision was made`,
      'This record changed while you were working. Reload the page, then approve with an administrator PIN.',
    );
  }
}

/** Tier R: the refusal when the typed name is not the record's name. Names the REAL name (the one the server loaded). */
export function retypeRefusalError(name: string) {
  return refuse(`confirmName did not match the record's name '${name}'`, retypeRefusal(name));
}
