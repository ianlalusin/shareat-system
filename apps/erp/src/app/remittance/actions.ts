'use server';

/**
 * Server actions for the remittance screens. T-143.
 *
 * Thin adapters: parse `FormData`, call the domain, redirect. ⛔ The gate is `authorize()` inside
 * each service, not here — a gate in a server action protects one caller.
 */
import { redirect } from 'next/navigation';
import {
  createRemittance,
  refuse,
  resolveRemittanceVariance,
  reverseRemittance,
  setStoreCashPolicy,
} from '@shareat/domain';
import { cashierAccounts, withOrgPrincipal } from './lib';
import { requireActor } from '../../lib/session';
import { errorMessage as sharedErrorMessage } from '@/lib/constraint-messages';
import { add, compare, isZero, money, ZERO } from '@shareat/core/money';
import { parseMoneyInput } from '@shareat/domain/money-input';

function str(fd: FormData, key: string): string {
  const v = fd.get(key);
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * ⭐ **Plain language for the constraints a person can actually hit** — a lookup keyed on what the
 * database reported, never a second copy of the rule.
 *
 * ⚠️ The distinction matters and is easy to get wrong: re-checking these conditions in TypeScript
 * would be a second source of truth that drifts (bible §6.3). **Deciding stays in the database;
 * only the wording is ours.** If a constraint is renamed the message stops matching and the raw
 * text shows through — visibly wrong rather than silently stale.
 */
const CONSTRAINT_MESSAGES: Record<string, string> = {
  stores_pooling_requires_ceiling_check:
    'Pooling cash needs a ceiling. Set the most that may sit un-remitted, or choose Daily.',
  stores_unremitted_ceiling_positive_check:
    'A ceiling of zero would mean remitting before selling anything. Leave it blank for Daily, ' +
    'or enter an amount above zero.',
  stores_remittance_cadence_check: 'That is not one of the cadences.',
};

/** Strips the throwing function's name — right for a log, useless on screen. */
function errorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  for (const [constraint, message] of Object.entries(CONSTRAINT_MESSAGES)) {
    if (raw.includes(constraint)) return message;
  }
  return sharedErrorMessage(err);
}

function back(params: Record<string, string>): never {
  redirect(`/remittance?${new URLSearchParams(params).toString()}`);
}

export async function createRemittanceAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const storeId = str(formData, 'storeId');
  let summary = '';

  try {
    // Fetched up front (T-328) so a malformed amount's own error can name the account, the same
    // way the orphaned-overage refusal below already does — a multi-row form where every row's
    // error says only "the amount handed over" leaves the operator to guess which of several
    // accounts has the typo.
    const accounts = await cashierAccounts(actor.orgId, storeId);
    const accountName = (id: string) => accounts.find((a) => a.id === id)?.name ?? id;

    // One line per cashier account handed over — the till and the wallet remit separately,
    // because they are different places reconciling against different things.
    const rawLines = formData.getAll('lineAccountId').map((id, i) => ({
      fromMoneyAccountId: String(id),
      toMoneyAccountId: str(formData, `lineTo_${i}`),
      amount: str(formData, `lineAmount_${i}`),
      declaredOverage: str(formData, `lineOverage_${i}`) || null,
    }));

    // T-328/7th-shape, updated by S5.5v Amendment A1 — used to be a bare `Number(amount) > 0`
    // check, so a mistyped amount ('abc', or a thousands separator like '3,000') was silently
    // treated as "no amount" — the same class of bug the filter has, just inline here twice. Blank
    // is still legitimately "nothing handed over from this account" (T-134 B3). Two decisions now
    // throw instead of vanishing: a non-blank string that fails to parse (below), and — since
    // S5.5s dropped the box's `min="0"` — a parsed amount that is negative (:91-98). Kept as a
    // plain `(amount) => boolean` — no account, no closure over anything else — so it stays a
    // single, direct, independently-testable decision.
    const isHandedOver = (amount: string): boolean => {
      if (!amount) return false;
      const parsed = parseMoneyInput(amount, 'createRemittanceAction: the amount handed over', 'The amount handed over');
      // T-343 S5.5s / DEF-470 item 7 — backs the dropped `min="0"`: without it, a negative line was
      // silently dropped by the `> 0` filter below rather than refused.
      if (compare(parsed, ZERO) < 0) {
        throw refuse(
          'createRemittanceAction: the amount handed over cannot be negative.',
          'The amount handed over cannot be negative.',
        );
      }
      return compare(parsed, ZERO) > 0;
    };

    // The account name is added HERE, at the call sites, not inside `isHandedOver` — whatever it
    // throws is re-thrown with the account attached, so the two refusal paths below both name the
    // row the operator needs to fix, the way the orphaned-overage message already did.
    const handedOverOn = (line: { fromMoneyAccountId: string; amount: string }): boolean => {
      try {
        return isHandedOver(line.amount);
      } catch (err) {
        const account = accountName(line.fromMoneyAccountId);
        const raw = `"${account}": ${err instanceof Error ? err.message : String(err)}`;
        if (err instanceof Error && 'userMessage' in err && typeof err.userMessage === 'string') {
          const human = err.userMessage;
          const lowered = human.charAt(0).toLowerCase() + human.slice(1);
          throw Object.assign(new Error(raw), { userMessage: `"${account}": ${lowered}` });
        }
        throw new Error(raw);
      }
    };

    // ⛔ The filter below keys on amount, same as always (§6 item 2: a declared overage must not
    // resurrect a blank-amount line). But dropping the whole line SILENTLY also drops a declared
    // overage the person actually typed, with nothing on screen saying so — refuse instead of
    // absorbing a money figure nobody asked to throw away.
    const orphanedOverage = rawLines.find((l) => l.declaredOverage && !handedOverOn(l));
    if (orphanedOverage) {
      throw new Error(
        `"${accountName(orphanedOverage.fromMoneyAccountId)}" has a declared overage but no ` +
          'amount handed over — enter the amount, or clear the overage.',
      );
    }

    const lines = rawLines.filter((l) => handedOverOn(l));

    if (lines.length === 0) {
      throw new Error('Enter what was handed over from at least one account.');
    }

    const result = await withOrgPrincipal(actor.orgId, (tx) =>
      createRemittance(tx, actor, {
        storeId,
        remittedOn: str(formData, 'remittedOn'),
        lines,
        reference: str(formData, 'reference') || null,
        notes: str(formData, 'notes') || null,
      }),
    );

    // ⭐ Says what it settled, by date. A handover that reports only a total leaves the person
    // unable to check the one thing they care about — which days are now clear.
    // ⭐ T-326/DEF-379 — routed through `parseMoneyInput` directly rather than relying on the
    // ordering that used to make a bare `money()` call here safe (this line only ever ran after
    // `createRemittance` had already validated every `declaredOverage` string itself). That
    // ordering was real but incidental — a future reader moving this earlier would have
    // resurrected `money()`'s raw, cashier-unreadable `TypeError`. `@shareat/domain/money-input`
    // is now reachable from `apps/erp`, so the display total gets the same readable refusal the
    // write path already had.
    const declaredTotal = lines.reduce(
      (sum, l) =>
        l.declaredOverage
          ? add(sum, parseMoneyInput(l.declaredOverage, 'createRemittance: the declared overage', 'A declared overage'))
          : sum,
      money('0'),
    );
    summary =
      `Handed over ${result.handedOver}. Settled ${result.settled.length} day` +
      `${result.settled.length === 1 ? '' : 's'}` +
      (result.settled.length > 0
        ? `: ${result.settled.map((s) => `${s.businessDate} ${s.amount}`).join(', ')}`
        : '') +
      '.' +
      (isZero(declaredTotal) ? '' : ` Declared overage ${declaredTotal}.`) +
      // DEF-366: branch on varianceId, set only when a variance ROW was actually inserted
      // (index.ts:337 guard, :347 assignment) — never on `variance`, which is just a number.
      // The domain refusal is what makes the two agree; resting this on a client-side gate
      // would contradict docs/RULES.md §1 rule 7.
      (result.varianceId
        ? ` ⚠️ ${compare(money(result.variance ?? '0'), ZERO) < 0 ? 'SHORT' : 'OVER'} by ${Math.abs(Number(result.variance)).toFixed(2)} — recorded as an open item.`
        : '');
  } catch (err) {
    back({ error: errorMessage(err), store: storeId });
  }
  back({ ok: summary, store: storeId });
}

export async function reverseRemittanceAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const storeId = str(formData, 'storeId');
  try {
    const reason = str(formData, 'reason');
    if (!reason) throw new Error('Say why this remittance is being reversed.');
    await withOrgPrincipal(actor.orgId, (tx) =>
      reverseRemittance(tx, actor, { remittanceId: str(formData, 'remittanceId'), reason }),
    );
  } catch (err) {
    back({ error: errorMessage(err), store: storeId });
  }
  back({ ok: 'Reversed. The days it settled are owed again.', store: storeId });
}

export async function resolveVarianceAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const storeId = str(formData, 'storeId');
  const varianceId = str(formData, 'varianceId');
  const action = str(formData, 'action');
  let ok = '';

  try {
    if (action === 'charge') {
      const personId = str(formData, 'personId');
      // ⛔ The refusal, surfaced early so the message is about the decision rather than a
      // constraint violation. FIFO put the residual on that date; the date says nothing about
      // who was holding the money.
      if (!personId) {
        throw new Error(
          'Choose who is being charged. The date the shortage landed on says where the ' +
            'arithmetic stopped, not who was holding the money.',
        );
      }
      await withOrgPrincipal(actor.orgId, (tx) =>
        resolveRemittanceVariance(tx, actor, {
          varianceId,
          action: 'charge',
          personId,
          // Present only when the handover came from more than one account (R5).
          fromMoneyAccountId: str(formData, 'fromMoneyAccountId') || null,
          reason: str(formData, 'reason') || null,
        }),
      );
      ok = 'Shortage charged. The person now owes it, and the day reads remitted.';
    } else if (action === 'recognise_income') {
      // T-366 S3 (Amendment A1, Q3): manager-confirmed, never automatic at handover.
      await withOrgPrincipal(actor.orgId, (tx) =>
        resolveRemittanceVariance(tx, actor, {
          varianceId,
          action: 'recognise_income',
          // Present only when the handover came from more than one account (R5).
          fromMoneyAccountId: str(formData, 'fromMoneyAccountId') || null,
          reason: str(formData, 'reason') || null,
        }),
      );
      ok = 'Overage recognised as other income (7350).';
    } else if (action === 'write_off') {
      // T-366 A1 (Ian, 2026-09-30): no write-off — a shortage is always charged to a person. The
      // screen no longer offers one, and the domain refuses it regardless of what a form posts.
      throw new Error('A shortage is always charged to the person who was holding the money.');
    } else {
      // T-366 S3 audit — any OTHER unrecognised action (a stale form field, a hand-crafted
      // request) gets a neutral refusal, not write_off's sentence, which would be misleading here.
      throw new Error('That action is not available.');
    }
  } catch (err) {
    back({ error: errorMessage(err), store: storeId });
  }
  back({ ok, store: storeId });
}

/**
 * T-152 — set the cadence and the ceiling. Bible row 129.
 *
 * ⚠️ **A blank ceiling is `null`, not `0`.** They mean opposite things: `null` is *"daily, so no
 * ceiling is needed"*, while `0` would mean *"remit before selling anything"*. The database
 * refuses `0` outright, and refuses `null` alongside a pooled cadence — so a half-filled form
 * comes back as that constraint's error rather than as a policy nobody meant to set.
 */
export async function setCashPolicyAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const storeId = str(formData, 'storeId');
  const cadence = str(formData, 'remittanceCadence');
  const rawCeiling = str(formData, 'unremittedCeiling');

  try {
    await withOrgPrincipal(actor.orgId, (tx) =>
      setStoreCashPolicy(tx, actor, {
        storeId,
        remittanceCadence: cadence as Parameters<typeof setStoreCashPolicy>[2]['remittanceCadence'],
        // T-371 R6: the domain parses the ceiling; a blank becomes NULL there (a nullable column).
        unremittedCeiling: rawCeiling,
      }),
    );
  } catch (err) {
    back({ error: errorMessage(err), store: storeId });
  }
  back({ ok: 'Cash policy updated.', store: storeId });
}
