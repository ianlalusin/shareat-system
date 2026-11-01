/**
 * ⭐ T-502 S4 - the admin's CSV import of the item draft list (`/items/import`). docs/tasks/502-expense-item-catalog.md section 4 S4 + 15.
 *
 * Two doors, one analysis: `previewItemImport` reads the file and says what each row would do (writes nothing); `confirmItemImport`
 * runs the SAME analysis again inside its own transaction (never trusting an earlier preview) and only then creates. All or nothing:
 * any row that is not `new` or `exists` refuses the whole file. A row that matches an existing item (by name or other-name) is
 * left alone, so uploading the same file twice changes nothing. Capability `approve_item_request` (any admin). Inserts go through
 * the repo, not `createItem` (that one is super-admin), and the code allocator still issues the codes.
 */
import { auditLogRepo, expensesRepo, itemsRepo, ITEM_KINDS, BASE_UNITS, type Tx } from '@shareat/db';
import type { BaseUnit, ItemKind } from '@shareat/db/schema';
import { authorize, type Actor } from '@shareat/auth';
import { parseCsv, type CsvRecord } from '@shareat/core/csv';
import { itemCodeStem } from './code';
import { allocateItemCode } from './code-allocation';
import { refuse } from '../shared/refusal';

import { ITEM_IMPORT_MAX_BYTES, ITEM_IMPORT_MAX_ROWS } from './import-limits';

export { ITEM_IMPORT_MAX_BYTES, ITEM_IMPORT_MAX_ROWS };

export type ItemImportStatus =
  | 'new'
  | 'exists'
  | 'alias_clash'
  | 'category_not_found'
  | 'subcategory_not_found'
  | 'subcategory_required'
  | 'invalid'
  | 'duplicate_in_file';

export const ITEM_IMPORT_STATUSES: readonly ItemImportStatus[] = [
  'new',
  'exists',
  'alias_clash',
  'category_not_found',
  'subcategory_not_found',
  'subcategory_required',
  'invalid',
  'duplicate_in_file',
];

export interface ItemImportRow {
  line: number;
  name: string;
  status: ItemImportStatus;
  reason?: string;
}

export interface ItemImportPreview {
  rows: ItemImportRow[];
  counts: Record<ItemImportStatus, number>;
  canConfirm: boolean;
}

const COLUMNS = ['item_name', 'kind', 'base_unit', 'expense_category', 'expense_subcategory', 'aliases'] as const;
type Column = (typeof COLUMNS)[number];

interface Plan {
  rows: ItemImportRow[];
  creates: {
    name: string;
    kind: ItemKind;
    baseUnit: BaseUnit;
    categoryId: string;
    subcategoryId: string | null;
    aliases: string[];
  }[];
}

const norm = (raw: string): string => raw.trim().replace(/\s+/g, ' ');
const key = (raw: string): string => norm(raw).toLowerCase();
const FORMULA_START = /^[=+\-@]/;

function parseFile(csvText: string): { line: number; cells: Record<Column, string> }[] {
  if (Buffer.byteLength(csvText, 'utf8') > ITEM_IMPORT_MAX_BYTES) {
    const s = `This file is larger than 1 MiB (${ITEM_IMPORT_MAX_BYTES.toLocaleString('en-US')} bytes), the most one import accepts. Split it into smaller files.`;
    throw refuse(s, s);
  }
  let records: CsvRecord[];
  try {
    records = parseCsv(csvText);
  } catch (e) {
    const s = e instanceof Error ? e.message : 'The file could not be read as a CSV.';
    throw refuse(s, s);
  }
  if (records.length === 0) {
    const s = 'The file is empty. Upload a CSV with a header line and one item per line.';
    throw refuse(s, s);
  }
  const header = records[0]!.cells.map((c) => c.trim().toLowerCase());
  const at = {} as Record<Column, number>;
  for (const col of COLUMNS) {
    const i = header.indexOf(col);
    if (i < 0) {
      const s = `The first line of the file must name the columns ${COLUMNS.join(', ')}. The column "${col}" is missing.`;
      throw refuse(s, s);
    }
    at[col] = i;
  }
  const data = records.slice(1);
  if (data.length > ITEM_IMPORT_MAX_ROWS) {
    const s = `This file has ${data.length.toLocaleString('en-US')} items; one import takes at most ${ITEM_IMPORT_MAX_ROWS.toLocaleString('en-US')}. Split it into smaller files.`;
    throw refuse(s, s);
  }
  return data.map((r) => ({
    line: r.line,
    cells: Object.fromEntries(COLUMNS.map((c) => [c, r.cells[at[c]] ?? ''])) as Record<Column, string>,
  }));
}

/** The one analysis both doors run. Reads only. */
async function analyse(tx: Tx, orgId: string, csvText: string): Promise<Plan> {
  const parsed = parseFile(csvText);
  const itemNames = await itemsRepo.listItemNamesForImport(tx, orgId);
  const aliasTexts = await itemsRepo.listAliasTextsForImport(tx, orgId);
  const cats = await expensesRepo.listCategories(tx, orgId);
  const subs = await expensesRepo.listSubcategories(tx, orgId);
  const existingNames = new Set(itemNames.map((i) => key(i.name)));
  const existingAliases = new Set(aliasTexts.map((a) => key(a.alias)));
  const catByKey = new Map(cats.map((c) => [key(c.category), c]));
  const fileNames = new Set(parsed.map((p) => key(p.cells.item_name)).filter((k) => k !== ''));

  const seenNames = new Set<string>();
  const seenAliases = new Set<string>();
  const rows: ItemImportRow[] = [];
  const creates: Plan['creates'] = [];

  for (const p of parsed) {
    const name = norm(p.cells.item_name);
    const out = (status: ItemImportStatus, reason?: string): void => {
      rows.push(reason ? { line: p.line, name, status, reason } : { line: p.line, name, status });
    };
    if (name === '') {
      out('invalid', 'The item name is blank. Type the name people will recognise.');
      continue;
    }
    if (FORMULA_START.test(name)) {
      out('invalid', `An item name cannot start with = + - or @ (a spreadsheet would read it as a formula). Rename "${name}".`);
      continue;
    }
    if (itemCodeStem(name) === null) {
      out('invalid', 'Give the item a name with letters or numbers in it.');
      continue;
    }
    const nameKey = name.toLowerCase();
    if (seenNames.has(nameKey)) {
      out('duplicate_in_file', `"${name}" appears more than once in the file. Keep one line for it.`);
      continue;
    }
    seenNames.add(nameKey);
    if (existingNames.has(nameKey) || existingAliases.has(nameKey)) {
      out('exists', 'Already in the list. Its other names and category in the file were not applied.');
      continue;
    }

    const kind = p.cells.kind.trim().toLowerCase();
    if (!(ITEM_KINDS as readonly string[]).includes(kind)) {
      out('invalid', `"${p.cells.kind.trim()}" is not a kind of item. Use one of: ${ITEM_KINDS.join(', ')}.`);
      continue;
    }
    const unit = p.cells.base_unit.trim().toLowerCase();
    if (!(BASE_UNITS as readonly string[]).includes(unit)) {
      out('invalid', `"${p.cells.base_unit.trim()}" is not a unit. Use one of: ${BASE_UNITS.join(', ')}.`);
      continue;
    }
    if (kind === 'service' && unit !== 'pcs') {
      out('invalid', 'A service (rent, power, water...) is counted as "each", so its unit must be pcs.');
      continue;
    }

    const catText = norm(p.cells.expense_category);
    const cat = catText === '' ? undefined : catByKey.get(catText.toLowerCase());
    if (!cat || !cat.isActive) {
      out(
        'category_not_found',
        catText === ''
          ? 'The expense category is blank. Every item you buy needs one; use the exact name of a category.'
          : `The expense category "${catText}" is not one of the active categories. Use its exact name.`,
      );
      continue;
    }
    const catSubs = subs.filter((s) => s.categoryId === cat.id && s.isActive);
    const subText = norm(p.cells.expense_subcategory);
    let subcategoryId: string | null = null;
    if (subText !== '') {
      const sub = catSubs.find((s) => key(s.name) === subText.toLowerCase());
      if (!sub) {
        out('subcategory_not_found', `"${subText}" is not an active sub-category under "${cat.category}". Use its exact name.`);
        continue;
      }
      subcategoryId = sub.id;
    } else if (catSubs.length > 0) {
      out('subcategory_required', `"${cat.category}" has sub-categories, so this item needs one of them (${catSubs.map((s) => s.name).join(', ')}).`);
      continue;
    }

    const aliases: string[] = [];
    const rowAliasKeys = new Set<string>();
    let problem: { status: ItemImportStatus; reason: string } | null = null;
    for (const raw of p.cells.aliases.split('|')) {
      const a = norm(raw);
      if (a === '') continue;
      const ak = a.toLowerCase();
      if (rowAliasKeys.has(ak)) continue;
      rowAliasKeys.add(ak);
      if (FORMULA_START.test(a)) problem = { status: 'invalid', reason: `An other-name cannot start with = + - or @. Fix "${a}".` };
      else if (ak === nameKey) problem = { status: 'alias_clash', reason: `The other name "${a}" is the same as the item's own name.` };
      else if (existingNames.has(ak) || fileNames.has(ak)) problem = { status: 'alias_clash', reason: `The other name "${a}" is already an item's official name.` };
      else if (existingAliases.has(ak) || seenAliases.has(ak)) problem = { status: 'alias_clash', reason: `The other name "${a}" is already used for another item.` };
      if (problem) break;
      aliases.push(a);
    }
    if (problem) {
      out(problem.status, problem.reason);
      continue;
    }
    for (const a of aliases) seenAliases.add(a.toLowerCase());
    out('new');
    creates.push({ name, kind: kind as ItemKind, baseUnit: unit as BaseUnit, categoryId: cat.id, subcategoryId, aliases });
  }
  return { rows, creates };
}

const OK: ReadonlySet<ItemImportStatus> = new Set<ItemImportStatus>(['new', 'exists']);

function summarise(plan: Plan): ItemImportPreview {
  const counts = Object.fromEntries(ITEM_IMPORT_STATUSES.map((s) => [s, 0])) as Record<ItemImportStatus, number>;
  for (const r of plan.rows) counts[r.status]++;
  return { rows: plan.rows, counts, canConfirm: plan.rows.length > 0 && plan.rows.every((r) => OK.has(r.status)) };
}

/** Read the file and say what each row would do. Writes nothing. Admin only (`approve_item_request`). */
export async function previewItemImport(tx: Tx, actor: Actor, csvText: string): Promise<ItemImportPreview> {
  await authorize(tx, actor, 'approve_item_request', {});
  return summarise(await analyse(tx, actor.orgId, csvText));
}

/**
 * Create the new items and their other-names, as the confirming admin, in the caller's transaction. Re-reads and re-checks the file
 * first; refuses the whole file if any row is a problem. Rows that already exist are skipped. Audited per item and per alias.
 */
export async function confirmItemImport(
  tx: Tx,
  actor: Actor,
  csvText: string,
): Promise<{ created: number; skipped: number; aliasesAdded: number }> {
  await authorize(tx, actor, 'approve_item_request', {});
  const plan = await analyse(tx, actor.orgId, csvText);
  const sum = summarise(plan);
  if (!sum.canConfirm) {
    const bad = plan.rows.filter((r) => !OK.has(r.status));
    const listed = bad.slice(0, 5).map((r) => `Line ${r.line} (${r.name || 'no name'}): ${r.reason ?? r.status}`);
    const more = bad.length > 5 ? ` ...and ${bad.length - 5} more.` : '';
    const s =
      plan.rows.length === 0
        ? 'Nothing was imported: the file has no items under the header line.'
        : `Nothing was imported: ${bad.length} line${bad.length === 1 ? '' : 's'} of the file need fixing first. ${listed.join(' ')}${more}`;
    throw refuse(s, s);
  }
  let aliasesAdded = 0;
  for (const c of plan.creates) {
    const code = await allocateItemCode(tx, actor.orgId, itemCodeStem(c.name)!);
    const { id } = await itemsRepo.insertItem(tx, {
      orgId: actor.orgId,
      code,
      name: c.name,
      kind: c.kind,
      baseUnit: c.baseUnit,
      notes: 'Created by CSV import.',
      createdBy: actor.personId,
      isPurchasable: true,
      sellableRetail: false,
      sellableWholesale: false,
      expenseCategoryId: c.categoryId,
      expenseSubcategoryId: c.subcategoryId,
    });
    await auditLogRepo.append(tx, actor.orgId, {
      actorPersonId: actor.personId,
      action: 'item.imported',
      storeId: null,
      entityId: id,
      before: null,
      after: { code, name: c.name, kind: c.kind, baseUnit: c.baseUnit, expenseCategoryId: c.categoryId, expenseSubcategoryId: c.subcategoryId },
      source: 'web',
    });
    for (const alias of c.aliases) {
      const { id: aliasId } = await itemsRepo.insertAlias(tx, { orgId: actor.orgId, itemId: id, alias, createdBy: actor.personId });
      aliasesAdded++;
      await auditLogRepo.append(tx, actor.orgId, {
        actorPersonId: actor.personId,
        action: 'item_alias.added',
        storeId: null,
        entityId: aliasId,
        before: null,
        after: { itemId: id, alias },
        source: 'web',
      });
    }
  }
  return { created: plan.creates.length, skipped: plan.rows.length - plan.creates.length, aliasesAdded };
}
