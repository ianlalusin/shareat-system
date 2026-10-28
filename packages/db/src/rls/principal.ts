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

import { sql as dsql } from 'drizzle-orm';
import { transaction, type Tx } from '../client';

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
 * ⛔ **The mistake is not dangerous, and it is only LOUD ON WRITES.** A write is refused with
 * `42501`. A READ returns zero rows and no error, so the caller reports whatever absence means in
 * its own vocabulary — measured 2026-09-11, DEF-287.
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

/**
 * ⭐ **THE way an application or a job opens a transaction under an org's principal** — T-231,
 * DEF-211. Everything above this line speaks postgres.js; the application speaks Drizzle, and
 * that mismatch is why `withPrincipal` had no callers and the same five lines were re-implemented
 * three times in source (`apps/erp/src/app/expenses/lib.ts`,
 * `packages/domain/src/scheduler/index.ts`) and 68 times in tests. Reach for this one.
 *
 * ## One round trip, and every value a bind parameter
 *
 * `SET LOCAL ROLE x` admits no parameter — which is why the three earlier copies each issued
 * `sql.raw` plus two `set_config` calls, three round trips deep. But `role` is an ordinary GUC, so
 * `set_config('role', $1, true)` says exactly the same thing and travels as a parameter.
 * Measured on a lane database: **+1.421 ms/tx for the three-statement form, +0.131 ms for this
 * one** — and no interpolation site, so there is nothing to validate and nothing to get wrong.
 *
 * ⛔ **Never rewrite this with `sql.raw`.** The old shape existed because the grammar forced it.
 *
 * ## The safety property, which is the whole point
 *
 * Every setting is TRANSACTION-scoped (`set_config(..., true)`), so the role and the org revert at
 * COMMIT or ROLLBACK. A pooled connection outlives a request; a session-scoped `SET` would serve
 * the NEXT request under the PREVIOUS user's identity — silent, intermittent, and precisely the
 * cross-tenant leak RLS exists to prevent. Proven, not assumed: `rls.test.ts` asserts the
 * transaction after this one sees the owner role and a NULL `app_current_org()`.
 *
 * ⚠️ A transaction opened WITHOUT this sees zero org-scoped rows, not everything (migration 0011
 * lines 20-24). It does not leak — but ⛔ **do not read the old claim that it "breaks a feature
 * loudly": that was true only of writes, and it was the sentence that let DEF-287 ship.**
 *
 * A write with no principal is refused with `42501`. A READ returns zero rows and no error, and
 * the caller then explains the emptiness in its own words — so the symptom is a confident,
 * WRONG message rather than a permission failure. Measured, not reasoned: with the restricted
 * role armed, 344 tests failed with *"no fiscal period covers …"* against periods that were
 * demonstrably present (`docs/tasks/265-def-218-restricted-role-repair.md`). ⭐ **That is the
 * shape to expect in production the day `DATABASE_URL` stops bypassing RLS: not errors —
 * nonsense, on screens where the data is plainly there.**
 */
export async function withOrgPrincipal<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return openAs('staff', orgId, fn);
}

/**
 * ⭐ **The same thing for work that no person asked for** — a cron, the month-end runner, a
 * backstop sweep. T-140, DEF-287.
 *
 * Identical to `withOrgPrincipal` in every way that RLS can observe: same role switch, same
 * `app.org_id`, same transaction scope. The single difference is that `app.principal_kind` reads
 * `'system'` rather than `'staff'`, so the transaction says truthfully that no human is behind it.
 *
 * ## Why this exists as its own name rather than a flag
 *
 * ⛔ **DEF-287 happened because two functions were NAMED `…AsSystem` and set no principal at all.**
 * The word "system" in this codebase had come to mean "no capability check, no person" — which is
 * a statement about `authorize()`, not about the database — and a reader who grepped for the
 * system principal found those names and stopped looking. Giving the database-level idea its own
 * callable name is what makes the two meanings distinguishable by grep.
 *
 * ⚠️ **`app_principal_kind()` is read by NO policy today** — migration `0011` defines the function
 * and nothing references it, verified 2026-09-11. So `'system'` versus `'staff'` currently changes
 * no row's visibility. It is recorded because it is true, and because the day a policy does want
 * to distinguish a cron from a person, the callers will already be honest.
 *
 * ⛔ **This is NOT `systemTransaction()` and must not be reached for in its place.** That function
 * escapes the tenant boundary for the enumerable set of operations that must see EVERY org
 * (`listOrgsToRun`, `bootstrapOrganization`) and its caller list is closed and build-enforced.
 * This one stays firmly inside one org — it is a tenant-scoped transaction whose actor happens to
 * be a machine. If you need to cross orgs, you need the other one, and you need to say so out loud.
 */
export async function withSystemOrgPrincipal<T>(
  orgId: string,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  return openAs('system', orgId, fn);
}

/**
 * T-398 S6 (K5) - the org principal PLUS the acting person. `withOrgPrincipal` sets the org only; the definers that act for a person (the franchisor's
 * `franchise_*` readers, `receive_inter_entity_shipment`, the system-bill definer) read `app.person_id` and refuse 42501 without it.
 *
 * Same single round trip and the same transaction scope as `withOrgPrincipal`: every setting is `set_config(..., true)`, so the role, the org AND the person
 * revert at COMMIT or ROLLBACK and the next transaction on the pooled connection sees none of them. A session-scoped setting here would serve the NEXT request
 * under the PREVIOUS person's identity.
 */
export async function withActorPrincipal<T>(
  orgId: string,
  personId: string,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  return openAs('staff', orgId, fn, personId);
}

/** The one implementation. See `withOrgPrincipal` above for why it is a single round trip. */
async function openAs<T>(
  kind: 'staff' | 'system',
  orgId: string,
  fn: (tx: Tx) => Promise<T>,
  personId?: string,
): Promise<T> {
  return transaction(async (tx) => {
    if (personId === undefined) {
      await tx.execute(dsql`
        select set_config('role', ${APP_ROLE}, true),
               set_config('app.principal_kind', ${kind}, true),
               set_config('app.org_id', ${orgId}, true)`);
    } else {
      await tx.execute(dsql`
        select set_config('role', ${APP_ROLE}, true),
               set_config('app.principal_kind', ${kind}, true),
               set_config('app.org_id', ${orgId}, true),
               set_config('app.person_id', ${personId}, true)`);
    }
    return fn(tx);
  });
}
