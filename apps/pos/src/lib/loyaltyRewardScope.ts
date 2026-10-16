/**
 * Per-store availability of a global loyalty reward.
 *
 * Rewards live in one global `loyaltyRewards` collection: an admin defines
 * them once, and every branch may offer them. Store managers decide which of
 * those their own branch actually offers, from Collections → Loyalty.
 *
 * Two fields decide it, and the order matters:
 *
 *  - `applicableStoreIds` — the admin's allow-list. Null / absent / empty
 *    means "every store", which is how every existing reward is stored, so
 *    nothing changes for rewards nobody has scoped.
 *  - `disabledStoreIds` — the manager's opt-out for their own store.
 *
 * The manager's toggle writes `disabledStoreIds` rather than rewriting the
 * admin's allow-list. Turning a reward off at one branch must not mean
 * materialising "all the other branches" into the allow-list, which would
 * silently exclude every store created afterwards.
 *
 * Kept free of `server-only` imports: the cashier's redeem panel filters with
 * it client-side, and `writeLoyaltyRedeem` enforces it inside the transaction.
 */

export type RewardStoreScope = {
  isActive?: boolean;
  applicableStoreIds?: string[] | null;
  disabledStoreIds?: string[] | null;
};

/** Whether `storeId` currently offers this reward. */
export function isRewardOfferedAtStore(reward: RewardStoreScope | null | undefined, storeId: string): boolean {
  if (!reward || !storeId) return false;
  if (reward.isActive === false) return false;

  const allowed = Array.isArray(reward.applicableStoreIds) ? reward.applicableStoreIds : null;
  if (allowed && allowed.length > 0 && !allowed.includes(storeId)) return false;

  const disabled = Array.isArray(reward.disabledStoreIds) ? reward.disabledStoreIds : [];
  return !disabled.includes(storeId);
}

/**
 * Whether the admin's allow-list permits this store at all.
 *
 * A reward scoped to other branches is not the manager's to switch on, so the
 * Loyalty tab shows it as unavailable instead of offering a toggle that the
 * server would refuse.
 */
export function isRewardAllowedAtStore(reward: RewardStoreScope | null | undefined, storeId: string): boolean {
  if (!reward || !storeId) return false;
  const allowed = Array.isArray(reward.applicableStoreIds) ? reward.applicableStoreIds : null;
  return !allowed || allowed.length === 0 || allowed.includes(storeId);
}
