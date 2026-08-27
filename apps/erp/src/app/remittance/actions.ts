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
  resolveRemittanceVariance,
  reverseRemittance,
} from '@shareat/domain';
import { withOrgPrincipal } from './lib';
import { requireActor } from '../../lib/session';

function str(fd: FormData, key: string): string {
  const v = fd.get(key);
  return typeof v === 'string' ? v.trim() : '';
}

/** Strips the throwing function's name — right for a log, useless on screen. */
function errorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.replace(/^[a-z][A-Za-z0-9_]*:\s*/, '');
}

function back(params: Record<string, string>): never {
  redirect(`/remittance?${new URLSearchParams(params).toString()}`);
}

export async function createRemittanceAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const storeId = str(formData, 'storeId');
  let summary = '';

  try {
    // One line per cashier account handed over — the till and the wallet remit separately,
    // because they are different places reconciling against different things.
    const lines = formData
      .getAll('lineAccountId')
      .map((id, i) => ({
        fromMoneyAccountId: String(id),
        toMoneyAccountId: str(formData, `lineTo_${i}`),
        amount: str(formData, `lineAmount_${i}`),
      }))
      .filter((l) => l.amount && Number(l.amount) > 0);

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
    summary =
      `Handed over ${result.handedOver}. Settled ${result.settled.length} day` +
      `${result.settled.length === 1 ? '' : 's'}` +
      (result.settled.length > 0
        ? `: ${result.settled.map((s) => `${s.businessDate} ${s.amount}`).join(', ')}`
        : '') +
      (result.variance
        ? `. ⚠️ ${Number(result.variance) < 0 ? 'SHORT' : 'OVER'} by ${Math.abs(Number(result.variance)).toFixed(2)} — recorded as an open item.`
        : '.');
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
          reason: str(formData, 'reason') || null,
        }),
      );
    } else {
      await withOrgPrincipal(actor.orgId, (tx) =>
        resolveRemittanceVariance(tx, actor, {
          varianceId,
          action: 'write_off',
          reason: str(formData, 'reason'),
        }),
      );
    }
  } catch (err) {
    back({ error: errorMessage(err), store: storeId });
  }
  back({ ok: 'Variance closed.', store: storeId });
}
