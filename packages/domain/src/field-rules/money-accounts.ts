/**
 * T-440 field rules for app/money-accounts (S6): add an account, rename one (and, for a cashier drawer, set its overdraft limit).
 */
import { defineFieldRules } from './check';

export const MONEY_ACCOUNT_CREATE_RULES = defineFieldRules('money-accounts.create', {
  name: { label: 'The account name', kind: 'text', max: 120, requires: 'Give the account a name (up to 120 characters).' },
  storeId: { label: 'The store', kind: 'text', requires: 'Choose a store - money always sits somewhere.' },
});

export const MONEY_ACCOUNT_RENAME_RULES = defineFieldRules('money-accounts.rename', {
  name: { label: 'The account name', kind: 'text', max: 120, requires: 'Give the account a name (up to 120 characters).' },
  overdraftLimit: { label: 'The overdraft limit', optional: true, kind: 'money', min: 0, rangeSays: 'An overdraft limit is how far below zero the drawer may go, so enter it as a positive number. Zero means it may never go below zero at all.' },
});
