/**
 * T-389 (DEF-617): the channel-settlements form that keeps what was typed after a refused save. Not a `'use server'`
 * file, so the page and the action import one definition. Only user-editable controls: never the hidden channelId.
 */
import { defineTypedForm } from '@/lib/keep-typing';

/** A channel's payout account. The record is the channel id. */
export const PAYOUT_DESTINATION_EDIT = defineTypedForm({
  form: 'channelSettlement.payout',
  fields: ['moneyAccountId'],
});
