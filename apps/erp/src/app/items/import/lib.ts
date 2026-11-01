/**
 * T-502 S4 - the pieces of /items/import that are not a server action (a 'use server' file may export only async functions).
 */
import { ITEM_IMPORT_MAX_BYTES } from '@shareat/domain/item-import-limits';
import type { ItemImportStatus } from '@shareat/domain';

/** The upload limit IS the domain's limit; the action checks it on the file's size before reading a byte of text. */
export const MAX_UPLOAD_BYTES: number = ITEM_IMPORT_MAX_BYTES;

/** What a person reads for each status. Never the raw code. */
export const IMPORT_STATUS_LABELS: Readonly<Record<ItemImportStatus, string>> = {
  new: 'New item, will be created',
  exists: 'Already in the list, skipped',
  alias_clash: 'Other name is already taken',
  category_not_found: 'Expense category not found',
  subcategory_not_found: 'Sub-category not found',
  subcategory_required: 'Sub-category needed',
  invalid: 'Something in this line is not valid',
  duplicate_in_file: 'Repeated in this file',
};

const FORMULA_START = /^[=+\-@\t\r]/;
const PLAIN_NUMBER = /^-?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?$/;

/**
 * A cell from the uploaded file, made safe to SHOW and to copy into a spreadsheet: text that starts with = + - @ (or a tab or
 * carriage return) would be read as a formula, so it is shown with a leading apostrophe. Plain numbers are left alone.
 */
export function safeCell(text: string): string {
  return FORMULA_START.test(text) && !PLAIN_NUMBER.test(text) ? `'${text}` : text;
}
