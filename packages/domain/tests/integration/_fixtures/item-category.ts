/**
 * T-502 S2: approving an item request now needs an expense category for a purchasable item. A test that is not ABOUT the category
 * gets the org's first active one from this helper (every fixture org seeds the categories).
 */
import { sql as dsql } from 'drizzle-orm';

import { approveItemRequest } from '@shareat/domain';

type ApproveArgs = Parameters<typeof approveItemRequest>;

export async function firstExpenseCategoryId(tx: ApproveArgs[0], orgId: string): Promise<string> {
  const rows = (await tx.execute(
    dsql`select id from expense_categories where org_id = ${orgId} and is_active order by category limit 1`,
  )) as unknown as { id: string }[];
  if (!rows[0]) throw new Error('fixture org has no active expense category');
  return rows[0].id;
}

/** approveItemRequest with a default category; an explicit `expenseCategoryId` in `input` wins. */
export async function approveWithCategory(tx: ApproveArgs[0], who: ApproveArgs[1], input: ApproveArgs[2]) {
  const expenseCategoryId = await firstExpenseCategoryId(tx, who.orgId);
  return approveItemRequest(tx, who, { expenseCategoryId, ...input });
}
