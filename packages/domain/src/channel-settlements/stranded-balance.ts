/**
 * T-606: a platform-file correction or period charge books on the channel's CURRENT receivable. While the channel still holds a balance on any OTHER account (its sales were
 * posted there before the receivable was changed) the figures would split across two accounts, so it is refused until the balance has been moved
 * (`moveChannelToChannelReceivable`). After the move the old day lines stay where they were posted and the balance is on the new account: booking the difference there is correct.
 * Computed as the S2 guard computes it: party = the channel, per store, posted entries only, drafts excluded.
 */
import { channelSettlementsRepo, salesDaysRepo, type Tx } from '@shareat/db';
import { add, compare, formatMoney, negate, ZERO, type Money } from '@shareat/core/money';
import { refuse } from '../shared/refusal';

export async function refuseStrandedChannelBalance(
  tx: Tx,
  orgId: string,
  channel: { id: string; name: string },
  currentCode: string,
  fn: string,
): Promise<void> {
  const off = await channelSettlementsRepo.partyBalancesOffAccount(tx, orgId, channel.id, currentCode);
  if (off.length === 0) return;
  const byAccount = new Map<string, Money[]>();
  for (const b of off) byAccount.set(b.accountCode, [...(byAccount.get(b.accountCode) ?? []), b.balance]);
  const parts: string[] = [];
  for (const [code, balances] of byAccount) {
    const total = add(...balances);
    const account = await salesDaysRepo.receivableAccountFor(tx, orgId, code);
    const where = `${code}${account ? ` ${account.name}` : ''}`;
    parts.push(compare(total, ZERO) < 0 ? `${formatMoney(negate(total))} in its favour on ${where}` : `${formatMoney(total)} on ${where}`);
  }
  throw refuse(
    `${fn}: channel ${channel.id} still has a balance on an account other than ${currentCode}`,
    `${channel.name} still has ${parts.join(' and ')}. Move it to Channel receivable in Settings \u203a Sales channels, then approve this file.`,
  );
}
