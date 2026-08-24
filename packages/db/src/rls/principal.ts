/**
 * The principal — who a transaction is acting as. T-120, ADR-008 §9–§10.
 *
 * Three kinds of actor exist and the third is why this is a *principal* rather than an
 * `orgId`: an external wholesale buyer belongs to no organization at all. They have a
 * catalogue, their prices, their orders and what they owe — no books, no ledger, no reports.
 *
 * **Everything here is TRANSACTION-scoped, and that is the whole safety property.** A pooled
 * connection outlives a request; a role or setting applied at session scope serves the NEXT
 * request under the PREVIOUS user's identity, and that failure is silent, intermittent, and
 * shows one owner another owner's data. `SET LOCAL` and `set_config(..., true)` are both
 * cleared at commit or rollback, so the leak is not merely avoided by discipline — it is
 * impossible to express.
 */

export type Principal =
  | { readonly kind: 'staff'; readonly orgId: string; readonly personId?: string }
  /** External wholesale buyer — no org, no books (ADR-008 §10, §11). */
  | { readonly kind: 'customer'; readonly customerId: string }
  /** Migrations, crons, the ETL and the audit. Connects as the owner; RLS does not apply. */
  | { readonly kind: 'system' };

/** Minimal shape of a postgres.js transaction, so this module needs no driver import. */
export interface PrincipalSink {
  unsafe(query: string, params?: unknown[]): Promise<unknown>;
}

export const APP_ROLE = 'shareat_app';

/**
 * Applies `principal` to the CURRENT TRANSACTION. Call it as the first statement inside every
 * transaction that serves a request.
 *
 * A `system` principal deliberately does nothing: it stays as the connecting (owner) role, for
 * which RLS does not apply. That is how the migrator, the ETL and the audit see everything —
 * and it is why a `system` principal must never be reachable from a request handler.
 */
export async function applyPrincipal(tx: PrincipalSink, principal: Principal): Promise<void> {
  if (principal.kind === 'system') return;

  // SET LOCAL, never SET. Reverts at commit or rollback, so it cannot outlive the request on
  // a pooled connection. The role name is a constant, never interpolated from input.
  await tx.unsafe(`set local role ${APP_ROLE}`);

  if (principal.kind === 'staff') {
    await tx.unsafe(`select set_config('app.principal_kind', 'staff', true)`);
    await tx.unsafe(`select set_config('app.org_id', $1, true)`, [principal.orgId]);
    if (principal.personId) {
      await tx.unsafe(`select set_config('app.person_id', $1, true)`, [principal.personId]);
    }
    return;
  }

  // Customer: NO org is set, so every org-scoped policy evaluates against NULL and matches
  // nothing. A customer is invisible to the books by construction rather than by a rule
  // someone remembered to write — and a table added later is invisible to them until a policy
  // deliberately admits it.
  await tx.unsafe(`select set_config('app.principal_kind', 'customer', true)`);
  await tx.unsafe(`select set_config('app.customer_id', $1, true)`, [principal.customerId]);
}

/**
 * Runs `fn` inside one transaction with `principal` applied.
 *
 * Prefer this over calling `applyPrincipal` by hand: forgetting the call yields a transaction
 * with no principal, which returns NOTHING from an org-scoped table rather than everything.
 * The mistake is loud, not dangerous — but it is still a mistake worth not making.
 */
export async function withPrincipal<T>(
  sql: { begin: <R>(fn: (tx: never) => Promise<R>) => Promise<R> },
  principal: Principal,
  fn: (tx: never) => Promise<T>,
): Promise<T> {
  return sql.begin(async (tx: never) => {
    await applyPrincipal(tx as unknown as PrincipalSink, principal);
    return fn(tx);
  });
}
