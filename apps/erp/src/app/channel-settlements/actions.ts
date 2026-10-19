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
import {
  assertFieldRules,
  previewChannelSettlement,
  recordChannelSettlement,
  setChannelPayoutDestination,
  voidChannelSettlement,
  type SettlementPreview,
} from '@shareat/domain';
import { CHANNEL_SETTLEMENT_VOID_RULES } from '@shareat/domain/field-rules';
import { withOrgPrincipal } from './lib';
import { requireActor } from '../../lib/session';
import { errorMessage } from '@/lib/constraint-messages';
import { redirectWithFlash } from '@/lib/flash';
import { keepTyping } from '@/lib/keep-typing';
import { PAYOUT_DESTINATION_EDIT } from './typed-forms';
import { verifyAdminApproval } from '@shareat/auth';
import { loadDestructiveTarget, recordApproval } from '@/lib/destructive';

function str(fd: FormData, key: string): string {
  const v = fd.get(key);
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * A blank deduction is OMITTED, not an error — most settlements use three of the six kinds. T-371 R6: the
 * deduction columns carry a default, so a blank box is left out (the domain books no such deduction) rather than
 * turned into an invented `'0'` here.
 */
function optional(fd: FormData, key: string): string | undefined {
  return str(fd, key) || undefined;
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
    // S5.5v Amendment A2 item 1 — the raw strings pass through unvalidated: the blank/parse
    // refusal for gross/net now lives in the domain, AFTER authorize(), never before it.
    const preview = await withOrgPrincipal(actor.orgId, (tx) =>
      previewChannelSettlement(tx, actor, {
        storeId: req.storeId,
        channelId: req.channelId,
        businessDate: req.businessDate,
        grossAmount: req.grossAmount,
        netDeposited: req.netDeposited,
        deductions: {
          commission: req.commission || undefined,
          marketing: req.marketing || undefined,
          platformFee: req.platformFee || undefined,
          vatOnFees: req.vatOnFees || undefined,
          withholdingTax: req.withholdingTax || undefined,
          penalty: req.penalty || undefined,
        },
        // T-371 R6 — a loan picked with a blank amount is a picker left open, exactly as the record path reads it.
        loan: req.loanId && req.loanAmount
          ? {
              loanId: req.loanId,
              amount: req.loanAmount,
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
    // T-440: the screen's rule set (CHANNEL_SETTLEMENT_RECORD_RULES) is asserted in recordChannelSettlement, AFTER authorize().
    const channelId = str(formData, 'channelId');
    const salesDayId = str(formData, 'salesDayId');
    if (!channelId) throw new Error('Choose the channel this payout is for.');
    // the blank-day refusal lives in recordChannelSettlement, AFTER authorize() and the field rules.

    // S5.5v Amendment A2 item 1 — raw strings, unvalidated: the blank/parse refusal for gross/net
    // now lives in the domain, AFTER authorize(), never before it.
    const grossAmount = str(formData, 'grossAmount');
    const netDeposited = str(formData, 'netDeposited');

    const loanId = str(formData, 'loanId');
    // ⚠️ A loan named with no amount is a picker left open, not a zero repayment — and the
    // schema's own CHECK refuses the pair anyway. Treated as "no loan" rather than surfaced as a
    // constraint error, because that is what the person meant.
    const loanAmount = str(formData, 'loanAmount');
    const hasLoan = loanAmount !== '' && Number(loanAmount) !== 0; // loanId may be blank: the domain rules see the amount, then drop the pair

    await withOrgPrincipal(actor.orgId, (tx) =>
      recordChannelSettlement(tx, actor, {
        storeId: str(formData, 'storeId'),
        channelId,
        salesDayId,
        businessDate: str(formData, 'businessDate'),
        grossAmount,
        netDeposited,
        deductions: {
          commission: optional(formData, 'commission'),
          marketing: optional(formData, 'marketing'),
          platformFee: optional(formData, 'platformFee'),
          vatOnFees: optional(formData, 'vatOnFees'),
          withholdingTax: optional(formData, 'withholdingTax'),
          penalty: optional(formData, 'penalty'),
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
    return await redirectWithFlash('/channel-settlements', {}, { error: errorMessage(err) });
  }

  return await redirectWithFlash('/channel-settlements', {}, { ok: 'posted' });
}

export async function voidSettlementAction(formData: FormData): Promise<void> {
  const actor = await requireActor();

  try {
    const reason = str(formData, 'reason');
    // T-412 Tier P: an administrator's PIN, verified on the server against the RECORD's store.
    const settlementId = str(formData, 'settlementId');
    const target = await loadDestructiveTarget(actor, 'channel_settlement', settlementId, ['record_ar_collection']);
    assertFieldRules(CHANNEL_SETTLEMENT_VOID_RULES, formData);
    const approval = await verifyAdminApproval(null, { actor, storeId: target.storeId, pin: str(formData, 'adminPin'), capability: 'record_ar_collection' });
    await withOrgPrincipal(actor.orgId, async (tx) => {
      await voidChannelSettlement(tx, actor, { settlementId, reason });
      await recordApproval(tx, actor, approval, { capability: 'record_ar_collection', entityType: 'channel_settlement', entityId: settlementId, storeId: target.storeId });
    });
  } catch (err) {
    return await redirectWithFlash('/channel-settlements', {}, { error: errorMessage(err) });
  }

  return await redirectWithFlash('/channel-settlements', {}, { stamp: 'VOID', ok: 'Settlement voided.' });
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
  let channelId = '';

  try {
    channelId = str(formData, 'channelId');
    const moneyAccountId = str(formData, 'moneyAccountId');
    await withOrgPrincipal(actor.orgId, (tx) => setChannelPayoutDestination(tx, actor, { channelId, moneyAccountId }));
  } catch (err) {
    return await redirectWithFlash('/channel-settlements', {}, { error: errorMessage(err), typed: keepTyping(formData, PAYOUT_DESTINATION_EDIT, str(formData, 'channelId'), { actorId: actor.personId }) });
  }

  // T-350 S5 — the redirect says WHICH channel and nothing else. Whether this was a first set, a
  // change, or a same-account no-op is derived entirely from the audit row on the next render
  // (`page.tsx`) — S4's `changed=1`/`same=1` flags re-created the exact "the URL says so" hole one
  // branch over, and this is the fix: the URL makes no claim at all. `changedChannel`, not
  // `channel` — that's the settlement form's own preselect register (`preselectChannelId`).
  return await redirectWithFlash('/channel-settlements', { changedChannel: channelId }, { ok: 'destination' });
}
