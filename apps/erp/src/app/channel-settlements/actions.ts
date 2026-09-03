'use server';

/**
 * Server actions for the channel-settlement screen. DEF-137, spec `docs/tasks/150-channel-settlement.md`.
 *
 * Thin adapters: read the actor from the session, parse, call the domain, redirect. ⛔ **No gate
 * is enforced here** — `recordChannelSettlement`, `voidChannelSettlement` and
 * `setChannelPayoutDestination` each call `authorize()` as their first statement. A gate in an
 * action protects one caller; a gate in the domain protects every caller there will ever be.
 *
 * ⭐ The actor comes from `requireActor()`, never the form (bible §7.1, T-138) — and
 * `tests/unit/no-client-supplied-actor.test.ts` fails the build if that ever changes.
 */
import { redirect } from 'next/navigation';
import {
  previewChannelSettlement,
  recordChannelSettlement,
  setChannelPayoutDestination,
  voidChannelSettlement,
  type SettlementPreview,
} from '@shareat/domain';
import { withOrgPrincipal } from './lib';
import { requireActor } from '../../lib/session';

function str(fd: FormData, key: string): string {
  const v = fd.get(key);
  return typeof v === 'string' ? v.trim() : '';
}

/** A blank money field is zero, not an error — most settlements use three of the six kinds. */
function money(fd: FormData, key: string): string {
  return str(fd, key) || '0';
}

/**
 * The message a person should read. Domain errors are prefixed with the function that threw —
 * right in a log, useless on screen — so a leading camelCase identifier and its colon go, and
 * nothing else: the sentence after it is already written for a human.
 */
function errorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.replace(/^[a-z][A-Za-z0-9_]*:\s*/, '');
}

export interface PreviewRequest {
  storeId: string;
  channelId: string;
  businessDate: string;
  grossAmount: string;
  netDeposited: string;
  commission: string;
  marketing: string;
  platformFee: string;
  vatOnFees: string;
  withholdingTax: string;
  penalty: string;
  loanId: string;
  loanAmount: string;
  loanOwnerStoreId: string;
  recognizeGain: boolean;
}

export type PreviewResponse = { ok: true; preview: SettlementPreview } | { ok: false; error: string };

/**
 * ⭐ **What this settlement will do, before it does it.**
 *
 * Called imperatively from the form on "Check the numbers", so the variance or gain — and the
 * tolerance refusal, which is the whole control — is on screen *before* the Post button becomes
 * usable. ⚠️ It computes nothing itself: `previewChannelSettlement` is the same arithmetic
 * `recordChannelSettlement` runs, so the two cannot disagree.
 */
export async function previewSettlementAction(req: PreviewRequest): Promise<PreviewResponse> {
  const actor = await requireActor();
  try {
    const preview = await withOrgPrincipal(actor.orgId, (tx) =>
      previewChannelSettlement(tx, actor, {
        storeId: req.storeId,
        channelId: req.channelId,
        businessDate: req.businessDate,
        grossAmount: req.grossAmount || '0',
        netDeposited: req.netDeposited || '0',
        deductions: {
          commission: req.commission || '0',
          marketing: req.marketing || '0',
          platformFee: req.platformFee || '0',
          vatOnFees: req.vatOnFees || '0',
          withholdingTax: req.withholdingTax || '0',
          penalty: req.penalty || '0',
        },
        loan: req.loanId
          ? {
              loanId: req.loanId,
              amount: req.loanAmount || '0',
              ownerStoreId: req.loanOwnerStoreId || null,
            }
          : null,
        recognizeGain: req.recognizeGain,
      }),
    );
    return { ok: true, preview };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

export async function recordSettlementAction(formData: FormData): Promise<void> {
  const actor = await requireActor();

  try {
    const channelId = str(formData, 'channelId');
    const salesDayId = str(formData, 'salesDayId');
    if (!channelId) throw new Error('Choose the channel this payout is for.');
    if (!salesDayId) {
      throw new Error(
        'Choose the day this payout settles. A settlement clears one verified channel-day — ' +
          'a payout covering several days is one settlement per day, sharing a reference.',
      );
    }

    const loanId = str(formData, 'loanId');
    // ⚠️ A loan named with no amount is a picker left open, not a zero repayment — and the
    // schema's own CHECK refuses the pair anyway. Treated as "no loan" rather than surfaced as a
    // constraint error, because that is what the person meant.
    const loanAmount = money(formData, 'loanAmount');
    const hasLoan = loanId !== '' && Number(loanAmount) !== 0;

    await withOrgPrincipal(actor.orgId, (tx) =>
      recordChannelSettlement(tx, actor, {
        storeId: str(formData, 'storeId'),
        channelId,
        salesDayId,
        businessDate: str(formData, 'businessDate'),
        grossAmount: money(formData, 'grossAmount'),
        netDeposited: money(formData, 'netDeposited'),
        deductions: {
          commission: money(formData, 'commission'),
          marketing: money(formData, 'marketing'),
          platformFee: money(formData, 'platformFee'),
          vatOnFees: money(formData, 'vatOnFees'),
          withholdingTax: money(formData, 'withholdingTax'),
          penalty: money(formData, 'penalty'),
        },
        loan: hasLoan
          ? {
              loanId,
              amount: loanAmount,
              ownerStoreId: str(formData, 'loanOwnerStoreId') || null,
            }
          : null,
        reference: str(formData, 'reference') || null,
        settledOn: str(formData, 'settledOn'),
        recognizeGain: formData.get('recognizeGain') === 'on',
      }),
    );
  } catch (err) {
    redirect(`/channel-settlements?error=${encodeURIComponent(errorMessage(err))}`);
  }

  redirect('/channel-settlements?ok=posted');
}

export async function voidSettlementAction(formData: FormData): Promise<void> {
  const actor = await requireActor();

  try {
    const reason = str(formData, 'reason');
    if (!reason) {
      throw new Error('Say why this settlement is being voided — a reversal with no reason is a gap.');
    }
    await withOrgPrincipal(actor.orgId, (tx) =>
      voidChannelSettlement(tx, actor, { settlementId: str(formData, 'settlementId'), reason }),
    );
  } catch (err) {
    redirect(`/channel-settlements?error=${encodeURIComponent(errorMessage(err))}`);
  }

  redirect('/channel-settlements?ok=voided');
}

/**
 * Point a channel at the wallet its payouts land in.
 *
 * ⚠️ This is on the settlement screen rather than a settings page on purpose: it is the one
 * missing setting that makes a settlement impossible, and the person who discovers it is the
 * person trying to record one. Hiding it behind a menu they have no reason to open is how a
 * screen ends up unusable in a way nobody reports.
 */
export async function setPayoutDestinationAction(formData: FormData): Promise<void> {
  const actor = await requireActor();

  try {
    const moneyAccountId = str(formData, 'moneyAccountId');
    if (!moneyAccountId) throw new Error('Choose the account this channel pays into.');
    await withOrgPrincipal(actor.orgId, (tx) =>
      setChannelPayoutDestination(tx, actor, {
        channelId: str(formData, 'channelId'),
        moneyAccountId,
      }),
    );
  } catch (err) {
    redirect(`/channel-settlements?error=${encodeURIComponent(errorMessage(err))}`);
  }

  redirect('/channel-settlements?ok=destination');
}
