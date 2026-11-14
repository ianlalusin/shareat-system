/**
 * T-440 field rules for app/settings (S7). One set per form; every sentence is the one the server spoke before this module,
 * so the screen's line and the server's refusal are the same words. Selects keep their option MEMBERSHIP on the server
 * (Q: a select already limits the choice); a rule here only says "a choice is needed".
 */
import { defineFieldRules } from './check';

/** /settings/organization: the registered TIN (digits; dashes and spaces are ignored and removed). Blank clears it. */
export const SETTINGS_ORGANIZATION_RULES = defineFieldRules('settings.setOrganizationIdentity', {
  tin: { label: 'The TIN', optional: true, kind: 'digits', min: 9, max: 12, strip: 'spaces-dashes', requires: 'A TIN must be 9-12 digits. Dashes and spaces are fine and are removed.' },
});

const TOLERANCE_SAYS = 'A tolerance is a number from 0 to 1 with at most four decimals, for example 0.10 for 10%.';
/** A fraction from 0 to 1 with at most four decimals ("0", "0.10", "1", "1.0000"). */
const TOLERANCE_PATTERN = '^(0+(\\.\\d{1,4})?|0*1(\\.0{1,4})?)$';

/** /settings/usage-tolerance, the organisation-wide band (required). */
export const SETTINGS_ORG_TOLERANCE_RULES = defineFieldRules('settings.setOrgUsageTolerance', {
  tolerance: { label: 'The tolerance', kind: 'pattern', pattern: TOLERANCE_PATTERN, patternSays: 'a fraction from 0 to 1', requires: TOLERANCE_SAYS },
});

/** /settings/usage-tolerance, one item's own band (empty removes it). */
export const SETTINGS_ITEM_TOLERANCE_RULES = defineFieldRules('settings.setItemUsageTolerance', {
  tolerance: { label: 'The tolerance', optional: true, kind: 'pattern', pattern: TOLERANCE_PATTERN, patternSays: 'a fraction from 0 to 1', requires: TOLERANCE_SAYS },
});

/** /settings/attendance, the new policy's start day (the config fields themselves are the S8/exempt helpers). */
export const SETTINGS_ATTENDANCE_POLICY_RULES = defineFieldRules('settings.updateAttendanceConfig', {
  effectiveFrom: { label: 'The effective date', kind: 'date' },
});

const CAP_SAYS = 'A cap is a whole number of days (0 or more), or empty for no limit.';
/** /settings/attendance, a leave limit (empty = no limit). */
export const SETTINGS_LEAVE_CAP_RULES = defineFieldRules('settings.saveLeaveCap', {
  monthlyCap: { label: 'Days per month', optional: true, kind: 'number', integer: true, min: 0, max: 366, requires: CAP_SAYS },
  yearlyCap: { label: 'Days per year', optional: true, kind: 'number', integer: true, min: 0, max: 366, requires: CAP_SAYS },
});

const LEAVE_KIND_SAYS = 'A leave kind needs a short code (letters, digits and underscores) and a name.';
/** /settings/attendance, a new kind of leave. */
export const SETTINGS_LEAVE_KIND_RULES = defineFieldRules('settings.addLeaveType', {
  label: { label: 'The name', kind: 'text', requires: LEAVE_KIND_SAYS },
  code: {
    label: 'The short code',
    kind: 'pattern',
    pattern: '^[A-Za-z][A-Za-z0-9_]{1,39}$',
    patternSays: 'letters, digits and underscores, starting with a letter',
    requires: LEAVE_KIND_SAYS,
  },
});

/** /settings/expense-categories: add and rename share the one name rule. */
export const SETTINGS_EXPENSE_CATEGORY_RULES = defineFieldRules('settings.expenseCategory', {
  category: { label: 'The category name', kind: 'text', requires: 'A category needs a name.' },
});

/** /settings/sales-channels: add and edit share the one name rule. */
export const SETTINGS_SALES_CHANNEL_RULES = defineFieldRules('settings.salesChannel', {
  name: { label: 'The channel name', kind: 'text', requires: 'A sales channel needs a name.' },
});

/**
 * T-511 S2b: /settings/sales-channels, the separate admin-only "Platform and store code" form. A blank pair clears it.
 * The code pattern accepts BOTH shapes (a Grab store UUID, or a Foodpanda code of 3 to 12 letters or digits); which shape
 * a given platform needs is the domain function's check, because it depends on the other box.
 */
const PLATFORM_CODE_SAYS = 'A store code is a UUID for Grab, or 3 to 12 letters or digits for Foodpanda.';
const HEX = '[0-9A-Fa-f]';
export const SETTINGS_PLATFORM_CODE_RULES = defineFieldRules('settings.setSalesChannelPlatformCode', {
  platform: { label: 'The platform', optional: true, kind: 'pattern', pattern: '^(grab|foodpanda)$', patternSays: 'Grab, Foodpanda, or none', requires: 'Choose Grab, Foodpanda, or none.' },
  code: {
    label: 'The store code',
    optional: true,
    kind: 'pattern',
    pattern: `^(?:${HEX}{8}-${HEX}{4}-${HEX}{4}-${HEX}{4}-${HEX}{12}|[A-Za-z0-9]{3,12})$`,
    patternSays: 'a UUID (Grab) or 3 to 12 letters or digits (Foodpanda)',
    requires: PLATFORM_CODE_SAYS,
  },
});

/** T-564: a comma-separated list of at most 20 entries, each at most 60 characters (a format limit only; the words are free). */
const LIST_PATTERN = '^[^,]{0,60}(?:,[^,]{0,60}){0,19}$';
const LIST_SAYS = 'at most 20 entries separated by commas, each at most 60 characters';

/** /settings/sales-channels, the per-store settlement wiring (T-564). The store key has a shape; labels and hints are free words with a size limit. */
export const SETTINGS_STORE_SETTLEMENT_RULES = defineFieldRules('settings.storeSettlement', {
  storeKey: {
    label: 'The store key',
    kind: 'pattern',
    pattern: '^[a-z0-9][a-z0-9-]{1,23}$',
    patternSays: '2 to 24 lowercase letters, numbers or dashes, starting with a letter or number',
  },
  matchLabels: {
    label: 'The outlet names',
    optional: true,
    kind: 'pattern',
    pattern: LIST_PATTERN,
    patternSays: LIST_SAYS,
    requires: 'Outlet names: give at most 20, separated by commas, each at most 60 characters.',
  },
  fileHints: {
    label: 'The file name starts',
    optional: true,
    kind: 'pattern',
    pattern: LIST_PATTERN,
    patternSays: LIST_SAYS,
    requires: 'File name starts: give at most 20, separated by commas, each at most 60 characters.',
  },
});

/** /settings/sales-channels, a channel's bank names (T-564). */
export const SETTINGS_BANK_HINTS_RULES = defineFieldRules('settings.setSalesChannelBankHints', {
  bankHints: {
    label: 'The bank names',
    optional: true,
    kind: 'pattern',
    pattern: LIST_PATTERN,
    patternSays: LIST_SAYS,
    requires: 'Bank names: give at most 20, separated by commas, each at most 60 characters.',
  },
});

/**
 * /settings/pos-link, the link form. `posStoreName` is a typed box only when POS cannot list its stores; in picker mode the
 * form carries a fixed value for it (the action takes POS's own name from the list), so the set is the same in both modes.
 */
export const SETTINGS_POS_LINK_RULES = defineFieldRules('settings.linkStoreToPos', {
  posStoreId: { label: 'The POS store', kind: 'text', requires: 'Choose or enter the POS store this store sells under.' },
  posStoreName: { label: 'The POS store name', kind: 'text', requires: 'Give the POS store a name so people can recognise it.' },
  salesChannelId: { label: 'The sales channel', kind: 'text', requires: "Choose the sales channel POS's sales land in." },
  posTaxType: { label: 'The tax type', kind: 'text', requires: "Choose the tax type shown in the POS store's settings." },
});

/** /settings/pos-link, the unlink reason. */
export const SETTINGS_POS_UNLINK_RULES = defineFieldRules('settings.unlinkStoreFromPos', {
  reason: { label: 'The reason', kind: 'text', max: 500, requires: 'Say why this store is being unlinked, in under 500 characters.' },
});

/** /settings/pos-link, a tender (add and edit share it). */
export const SETTINGS_TENDER_RULES = defineFieldRules('settings.tender', {
  name: { label: 'The tender name', kind: 'text', requires: 'Give the tender a name.' },
  kind: { label: 'The tender kind', kind: 'text', requires: 'Choose whether this tender is cash or a wallet.' },
});

const BUSINESS_RULE_VALUE_SAYS = 'A value is a plain number with at most two decimals, for example 50 or 12.5.';
/**
 * /settings/business-rules (T-512): the shape of a new value, its start day and its reason, for the live line only. The bounds differ per rule
 * and belong to the registry, so `setBusinessRule` judges them (and refuses a start day before today and an enormous reason in its own words).
 */
export const SETTINGS_BUSINESS_RULE_RULES = defineFieldRules('settings.setBusinessRule', {
  value: { label: 'The new value', kind: 'pattern', pattern: '^\\d+(\\.\\d{1,2})?$', patternSays: 'a plain number with at most two decimals', requires: BUSINESS_RULE_VALUE_SAYS },
  effectiveFrom: { label: 'The start day', kind: 'date', notBeforeToday: true },
  reason: { label: 'The reason', kind: 'text', plainText: true, max: 500, requires: 'Say why the rule is changing, in under 500 characters.' },
});
