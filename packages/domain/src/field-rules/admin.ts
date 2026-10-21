/**
 * T-440 field rules for app/admin: store creation and details, the opening date, the access-defaults copy, the role pick and
 * the sign-in account link / unlink / grant-revoke forms. Existing server sentences are kept verbatim through `requires`.
 */
import { defineFieldRules } from './check';

/** Copy position defaults from another store. */
export const ADMIN_COPY_DEFAULTS_RULES = defineFieldRules('admin.copyDefaults', {
  sourceStoreId: { label: 'The store to copy from', kind: 'text', requires: 'Choose a store to copy from.' },
});

/** Open a branch. A ceiling, when given, must be positive (the database CHECK is the last word). */
export const ADMIN_STORE_CREATE_RULES = defineFieldRules('admin.createStore', {
  code: { label: 'The code', kind: 'text', max: 16 },
  name: { label: 'The name', kind: 'text' },
  openingDate: { label: 'The opening date', optional: true, kind: 'date' },
  unremittedCeiling: { label: 'The unremitted ceiling', optional: true, kind: 'money', min: 0.01 },
});

/** Store details. The TIN branch code is 3 to 5 digits; dashes and spaces are ignored. */
export const ADMIN_STORE_DETAILS_RULES = defineFieldRules('admin.updateStore', {
  name: { label: 'The name', kind: 'text' },
  tinBranchCode: { label: 'The TIN branch code', optional: true, kind: 'digits', min: 3, max: 5, strip: 'spaces-dashes' },
});

/** Set or clear the opening date. */
export const ADMIN_STORE_OPENING_DATE_RULES = defineFieldRules('admin.setStoreOpeningDate', {
  openingDate: { label: 'The opening date', optional: true, kind: 'date' },
});

/** Assign or change a role (membership of the role list stays server-only). */
export const ADMIN_ASSIGN_ROLE_RULES = defineFieldRules('admin.assignRole', {
  role: { label: 'The role', kind: 'text', requires: 'Pick a role.' },
});

/** Revoke a capability grant: a reason is mandatory. */
export const ADMIN_GRANT_REVOKE_RULES = defineFieldRules('admin.revokeGrant', {
  reason: {
    label: 'The reason',
    kind: 'text',
    requires: 'Revoking a grant needs a reason — a revoked grant nobody can explain is not an audit trail.',
  },
});

/** Unlink a sign-in account: a reason is mandatory. */
export const ADMIN_UNLINK_RULES = defineFieldRules('admin.unlinkCredential', {
  reason: {
    label: 'The reason',
    kind: 'text',
    requires: 'Unlinking a sign-in account needs a reason — a revoked credential nobody can explain is not an audit trail.',
  },
});

/** Link an email account by its Firebase uid. */
export const ADMIN_LINK_FIREBASE_RULES = defineFieldRules('admin.linkFirebase', {
  uid: { label: 'The Firebase uid', kind: 'text' },
});
