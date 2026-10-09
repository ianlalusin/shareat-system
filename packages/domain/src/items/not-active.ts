/**
 * T-383 S2b (B2.5). The one sentence every "this item cannot be ordered / received / priced / mapped / put on a
 * recipe" refusal says, so a retired or merged item is described the same way on every screen. Plain words only:
 * no id and no item name (I6). `status` is the item's own status; the caller tests `item.status !== 'active'`, so a
 * merged item is refused too.
 */
export function notActiveItemSentence(status: string, what: string, where?: string): string {
  const lead = where ? `${where}: this item` : 'This item';
  return status === 'merged'
    ? `${lead} was merged into another, so it cannot be ${what}. Use the item it was merged into.`
    : `${lead} is retired, so it cannot be ${what}. Use its replacement, or ask a super-admin to restore it.`;
}
