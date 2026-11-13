import { requirePageAccess } from '../../../lib/page-access';
import {
  createCategoryAction,
  createSubcategoryAction,
  renameCategoryAction,
  renameSubcategoryAction,
  setSubcategoryActiveAction,
  setCategoryAccountAction,
  setCategoryActiveAction,
} from './actions';
import { categoriesForAdmin, mappableAccounts, subcategoriesForAdmin } from './lib';
import { Page } from '@/components/shell/Page';
import { ACTION_LINK } from '@/components/action-link';
import { PageDescription } from '@/components/shell/PageDescription';
import { CheckedForm, EditableRecord } from '@/components/forms';
import { SETTINGS_EXPENSE_CATEGORY_RULES, nativeAttrs } from '@shareat/domain/field-rules';
import { Button, Card, DialogActions, EmptyState, Field, FlashBanner, FormGrid, FormModal, Input, Select, Table, Td, Th } from '@/components/ui';
import { FilterRow } from '@/components/FilterRow';
import { withFlash } from '@/lib/flash';
import { typedFor } from '@/lib/keep-typing';
import { EXPENSE_CATEGORY_ACCOUNT, EXPENSE_CATEGORY_RENAME, EXPENSE_SUBCATEGORY_RENAME } from './typed-forms';

export const metadata = { title: 'Expense categories — Shareat System' };
export const dynamic = 'force-dynamic';

interface SearchParams {
  ok?: string;
  error?: string;
  group?: string;
  q?: string;
}

/**
 * `/settings/expense-categories`. T-229 slice 1 — **DEF-193's remedy.**
 *
 * ⭐ The screen exists because a detector had nowhere to send anyone. T-213's
 * `expenseCategoryUnpostable` reports a draft expense stuck behind a category with no mapped
 * account and ends *"cannot post until one is"* — and until today the only writer
 * `expense_categories` had ever had was its seed file, so the instruction named an action nobody
 * could take.
 *
 * ⭐ **Unmapped rows sort first and say what they are holding up.** A list ordered by name would
 * bury the two rows that need a decision among thirty-eight that do not.
 *
 * ⛔ **Mapping only — no create, no rename, no retire.** Those wait for slice 2's migration,
 * because `unique (org_id, category)` is case- and whitespace-sensitive today and bible §4.4
 * rule 3 wants `lower(trim(...))`. Shipping creation first would re-open the duplicated-Rent
 * defect that rule exists to close.
 */
export default async function ExpenseCategoriesSettingsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await withFlash(searchParams);
  const { actor, refusal } = await requirePageAccess('/settings/expense-categories');
  // ⭐ T-288 — the READ gate. Ian, 2026-09-12: "do both hide the menu and gate the reads."
  if (refusal) return refusal;

  const [categories, accounts, subcategories] = await Promise.all([
    categoriesForAdmin(actor.orgId),
    mappableAccounts(actor.orgId),
    subcategoriesForAdmin(actor.orgId),
  ]);

  const unmapped = categories.filter((c) => c.accountCode === null);
  const blockedTotal = unmapped.reduce((n, c) => n + c.blockedDraftCount, 0);
  const accountByCode = new Map(accounts.map((a) => [a.code, a]));
  const groupFilter =
    sp.group && ['CAPEX', 'COGS', 'OPEX', 'PERSONAL'].includes(sp.group) ? sp.group : '';
  const query = (sp.q ?? '').trim().toLowerCase();
  const filtered = categories.filter((c) => {
    if (groupFilter && c.group !== groupFilter) return false;
    if (!query) return true;
    return [c.category, c.group, accountByCode.get(c.accountCode ?? '')?.name]
      .filter((value): value is string => Boolean(value))
      .some((value) => value.toLowerCase().includes(query));
  });
  const grouped = new Map<string, typeof filtered>();
  for (const category of filtered) {
    const rows = grouped.get(category.group) ?? [];
    rows.push(category);
    grouped.set(category.group, rows);
  }
  const groups = [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b));

  return (
    <Page density="table">
      <div>
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          <a href="/settings" className="underline">
            Settings
          </a>{' '}
          / Expense categories
        </p>
        <h1 className="text-2xl font-semibold">Expense categories</h1>
        <PageDescription>
          Which account each kind of spend debits. A category with{' '}
          <strong>no account mapped blocks posting</strong> rather than guessing — nothing here
          ever falls back to a catch-all account, so an unmapped category is a decision waiting,
          not a default.
        </PageDescription>
      </div>

      <FlashBanner flash={sp} />

      <p className="rounded-lg border border-neutral-200 p-4 text-sm dark:border-neutral-800">
        {unmapped.length === 0 ? (
          <>
            All {categories.length} categories are mapped. Nothing is blocked on this screen.
          </>
        ) : (
          <>
            <strong>
              {unmapped.length} of {categories.length}
            </strong>{' '}
            {unmapped.length === 1 ? 'category has' : 'categories have'} no account, holding up{' '}
            <strong>{blockedTotal}</strong> draft {blockedTotal === 1 ? 'expense' : 'expenses'}.
            They are listed first.
          </>
        )}
      </p>

      <FilterRow>
        <label className="text-sm">
          <span className="block text-muted">Group</span>
          <Select name="group" defaultValue={groupFilter} className="mt-1">
            <option value="">All groups</option>
            <option value="CAPEX">CAPEX — equipment</option>
            <option value="COGS">COGS — cost of goods sold</option>
            <option value="OPEX">OPEX — running cost</option>
            <option value="PERSONAL">PERSONAL — owner’s drawings</option>
          </Select>
        </label>
        <label className="min-w-48 flex-1 text-sm">
          <span className="block text-muted">Search</span>
          <Input name="q" defaultValue={sp.q ?? ''} placeholder="Category or account" className="mt-1 w-full" />
        </label>
      </FilterRow>

      <p className="text-xs text-muted">
        {filtered.length} of {categories.length} categories · {unmapped.length} unmapped
      </p>

      {filtered.length === 0 ? (
        <EmptyState
          illustration="magnifier"
          title="No categories match"
          body="Clear the group or search filter to see the rest of the register."
        />
      ) : (
        <div className="space-y-7">
          {groups.map(([groupName, rows]) => (
            <section key={groupName} className="space-y-2">
              <div className="flex items-baseline gap-2">
                <h2 className="text-sm font-semibold">{groupName}</h2>
                <span className="text-xs tabular-nums text-muted">{rows.length}</span>
              </div>
              <Table card={{ title: 'Category', subtitle: 'Posts to' }}>
                <thead>
                  <tr>
                    <Th>Category</Th>
                    <Th>Group</Th>
                    <Th>Blocking</Th>
                    <Th>Posts to</Th>
                    <Th className="w-28" />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((c) => {
                    const isUnmapped = c.accountCode === null;
                    const mapped = accountByCode.get(c.accountCode ?? '');
                    return (
                      <tr
                        key={c.id}
                        className={
                          !c.isActive ? 'opacity-60' : isUnmapped ? 'bg-warning-soft/40' : undefined
                        }
                      >
                        <Td data-card-heading={c.category}>
                          <span className="font-medium">{c.category}</span>
                          {isUnmapped && (
                            <span className="ml-2 rounded-full bg-warning-soft px-2 py-0.5 text-xs font-medium text-warning-ink">
                              unmapped
                            </span>
                          )}
                          {c.isSystem && (
                            <span className="ml-2 rounded-full bg-canvas px-2 py-0.5 text-xs text-muted">
                              seeded
                            </span>
                          )}
                          {!c.isActive && (
                            <span className="ml-2 rounded-full bg-closed-soft px-2 py-0.5 text-xs text-closed">
                              retired
                            </span>
                          )}
                          {/* T-502 section 11: sub-categories, set on the ITEM (a cashier never picks one). Add, rename, retire; never delete. */}
                          <div className="mt-2 space-y-1 border-l border-surface-border pl-3">
                            {subcategories.filter((s) => s.categoryId === c.id).map((s) => (
                              <div key={s.id} className={`flex flex-wrap items-center gap-2 text-xs ${s.isActive ? '' : 'opacity-60'}`}>
                                <span>{s.name}{!s.isActive ? ' (retired)' : ''}</span>
                                <EditableRecord action={renameSubcategoryAction} label={s.name} hidden={{ subcategoryId: s.id }} typed={typedFor(sp, EXPENSE_SUBCATEGORY_RENAME, s.id, actor.personId)}>
                                  <FormGrid layout="fields">
                                    <Field label="Name" width="name">
                                      <Input name="name" defaultValue={s.name} aria-label={`Name of ${s.name}`} className="w-full" />
                                    </Field>
                                  </FormGrid>
                                </EditableRecord>
                                <form action={setSubcategoryActiveAction}>
                                  <input type="hidden" name="subcategoryId" value={s.id} />
                                  <input type="hidden" name="isActive" value={s.isActive ? 'false' : 'true'} />
                                  <button type="submit" className={`${ACTION_LINK} text-muted hover:text-ink`}>
                                    {s.isActive ? 'Retire' : 'Reinstate'}
                                  </button>
                                </form>
                              </div>
                            ))}
                            <FormModal trigger="+ Sub-category" title={`Add a sub-category to ${c.category}`} size="sm">
                              <form action={createSubcategoryAction} className="space-y-3">
                                <input type="hidden" name="categoryId" value={c.id} />
                                <FormGrid layout="fields">
                                  <Field label="Name" width="name">
                                    <Input name="name" placeholder="Pork" className="w-full" />
                                  </Field>
                                </FormGrid>
                                <DialogActions>
                                  <Button type="submit" variant="primary">Save</Button>
                                </DialogActions>
                              </form>
                            </FormModal>
                          </div>
                        </Td>
                        <Td className="text-xs text-muted">{c.group}</Td>
                        <Td className="text-xs">
                          {c.blockedDraftCount === 0 ? (
                            '—'
                          ) : (
                            <span className="font-medium text-warning-ink">
                              {c.blockedDraftCount} draft{c.blockedDraftCount === 1 ? '' : 's'}
                            </span>
                          )}
                        </Td>
                        <Td>
                          {mapped ? (
                            <span>
                              {c.accountCode} · {mapped.name}
                            </span>
                          ) : (
                            <span className="text-warning-ink">Not mapped — blocks posting</span>
                          )}
                        </Td>
                        <Td className="text-right whitespace-nowrap">
                          <div data-card-ignore className="flex flex-wrap items-center justify-end gap-1">
                            {!c.isSystem && (
                              <EditableRecord
                                action={renameCategoryAction}
                                label={c.category}
                                hidden={{ categoryId: c.id }}
                                typed={typedFor(sp, EXPENSE_CATEGORY_RENAME, c.id, actor.personId)}
                                rules={SETTINGS_EXPENSE_CATEGORY_RULES}
                              >
                                <FormGrid layout="fields">
                                  <Field label="Name" width="name" rule={SETTINGS_EXPENSE_CATEGORY_RULES.category}>
                                    <Input
                                      {...nativeAttrs(SETTINGS_EXPENSE_CATEGORY_RULES.category)}
                                      defaultValue={c.category}
                                      aria-label={`Name of ${c.category}`}
                                      className="w-full"
                                    />
                                  </Field>
                                </FormGrid>
                              </EditableRecord>
                            )}
                            {mapped ? (
                              <EditableRecord
                                action={setCategoryAccountAction}
                                label={`account for ${c.category}`}
                                hidden={{ categoryId: c.id, categoryLabel: c.category }}
                                typed={typedFor(sp, EXPENSE_CATEGORY_ACCOUNT, c.id, actor.personId)}
                              >
                                <FormGrid layout="fields">
                                  <Field label="Posts to" width="name">
                                    <Select
                                      name="accountCode"
                                      defaultValue={c.accountCode ?? ''}
                                      className="w-full"
                                      aria-label={`Account for ${c.category}`}
                                    >
                                      {/* ⭐ A real choice, not a placeholder: picking it CLEARS the mapping.
                                          `account_code` is nullable on purpose so a wrong mapping is
                                          removable — a wrong account posts silently, an absent one refuses. */}
                                      <option value="">— none (blocks posting) —</option>
                                      {accounts.map((a) => (
                                        <option key={a.code} value={a.code}>
                                          {a.code} · {a.name}
                                        </option>
                                      ))}
                                    </Select>
                                  </Field>
                                </FormGrid>
                              </EditableRecord>
                            ) : (
                              <FormModal trigger="Set account" triggerLabel={`Set account for ${c.category}`} title={`Set account for ${c.category}`} size="sm">
                                <form action={setCategoryAccountAction} className="space-y-3">
                                  <input type="hidden" name="categoryId" value={c.id} />
                                  <input type="hidden" name="categoryLabel" value={c.category} />
                                  <FormGrid layout="fields">
                                    <Field label="Posts to" width="name">
                                      <Select
                                        name="accountCode"
                                        defaultValue=""
                                        className="w-full"
                                        aria-label={`Account for ${c.category}`}
                                      >
                                        <option value="">— none (blocks posting) —</option>
                                        {accounts.map((a) => (
                                          <option key={a.code} value={a.code}>
                                            {a.code} · {a.name}
                                          </option>
                                        ))}
                                      </Select>
                                    </Field>
                                  </FormGrid>
                                  <DialogActions>
                                    <Button type="submit" variant="primary">
                                      Save
                                    </Button>
                                  </DialogActions>
                                </form>
                              </FormModal>
                            )}
                            <form action={setCategoryActiveAction}>
                              <input type="hidden" name="categoryId" value={c.id} />
                              <input type="hidden" name="categoryLabel" value={c.category} />
                              <input type="hidden" name="isActive" value={c.isActive ? 'false' : 'true'} />
                              <button
                                type="submit"
                                className={`${ACTION_LINK} text-xs text-muted hover:text-ink`}
                              >
                                {c.isActive ? 'Retire' : 'Reinstate'}
                              </button>
                            </form>
                          </div>
                        </Td>
                      </tr>
                    );
                  })}
                </tbody>
              </Table>
            </section>
          ))}
        </div>
      )}


      {/* ⭐ T-229 slice 2. The database change this paragraph used to promise is migration 0134:
          uniqueness moved to `lower(trim(category))`, so a hand-typed name can no longer collide
          with a seeded one by case or spacing — bible §4.4 rule 3, DEF-205. */}
      <Card>
        <div className="flex items-center justify-between gap-3">
          <h2 className="font-semibold">Add a category</h2>
          <FormModal trigger="+ Add category" title="Add a category" size="md">
            <CheckedForm rules={SETTINGS_EXPENSE_CATEGORY_RULES} action={createCategoryAction} className="space-y-3 text-sm">
              <FormGrid layout="fields">
                <Field label="Name" width="name" rule={SETTINGS_EXPENSE_CATEGORY_RULES.category}>
                  <Input {...nativeAttrs(SETTINGS_EXPENSE_CATEGORY_RULES.category)} placeholder="Scooter rental" className="w-full" />
                </Field>
                <Field label="Group" width="name">
                  <Select name="group" defaultValue="OPEX" className="w-full">
                    <option value="OPEX">OPEX — running cost</option>
                    <option value="COGS">COGS — cost of goods sold</option>
                    <option value="CAPEX">CAPEX — equipment</option>
                    <option value="PERSONAL">PERSONAL — owner&apos;s drawings</option>
                  </Select>
                </Field>
                <Field label="Posts to" width="name">
                  <Select name="accountCode" defaultValue="" className="w-full">
                    <option value="">— none (blocks posting) —</option>
                    {accounts.map((a) => (
                      <option key={a.code} value={a.code}>
                        {a.code} · {a.name}
                      </option>
                    ))}
                  </Select>
                </Field>
              </FormGrid>
              <DialogActions>
                <Button type="submit" variant="primary">
                  Save
                </Button>
              </DialogActions>
            </CheckedForm>
          </FormModal>
        </div>
        <p className="mt-3 text-xs text-muted">
          Names are compared ignoring case and spacing. A category is <strong>retired, never deleted</strong> — everything
          already recorded in it keeps working.
        </p>
      </Card>

      <p className="text-xs text-neutral-500 dark:text-neutral-400">
        Stuck drafts appear on{' '}
        <a href="/findings" className="underline">
          /findings
        </a>{' '}
        once they are three days old.
      </p>
    </Page>
  );
}
