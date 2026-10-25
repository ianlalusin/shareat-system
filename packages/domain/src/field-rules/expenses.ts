/**
 * T-440 field rules for app/expenses (S6): the new-expense form, the void form, the staff-reimbursement payout and the recurring
 * template. Cross-field checks (interval against anchor day; a past start date) stay server refusals (Q4).
 */
import { defineFieldRules } from './check';

export const EXPENSE_CREATE_RULES = defineFieldRules('expenses.create', {
  supplierInvoiceId: { label: 'The supplier invoice', kind: 'text', requires: 'Choose a supplier invoice.' },
  categoryId: { label: 'The category', kind: 'text', requires: 'Choose a category.' },
  particulars: { label: 'The particulars', kind: 'text', requires: 'Say what this expense was actually for.' },
});

export const EXPENSE_VOID_RULES = defineFieldRules('expenses.void', {
  reason: { label: 'The reason', kind: 'text', requires: 'Say why this expense is being voided - a reversal with no reason is a gap.' },
});

/**
 * T-475 S2: "Approve & post" on a draft (approveExpenseAction). It has no ruled field: the invoice, the month and the other
 * blockers are BUSINESS rules (`@shareat/domain/business-rules`). The empty set makes the form a CheckedForm so those can turn Save off.
 */
export const EXPENSE_APPROVE_RULES = defineFieldRules('expenses.approve', {});

/** T-475 S2 (E4): "Correct this draft". No ruled field; the category rule is a BUSINESS rule. The empty set gives the EditableRecord a check context. */
export const EXPENSE_DRAFT_EDIT_RULES = defineFieldRules('expenses.draftEdit', {});

export const EXPENSE_REIMBURSEMENT_RULES = defineFieldRules('expenses.reimbursement', {
  amount: { label: 'The reimbursement amount', kind: 'money', min: 0.01 },
  on: { label: 'The date', kind: 'date' },
  fromMoneyAccountId: { label: 'The account to pay from', kind: 'text', requires: 'Choose the account to pay from.' },
});

export const RECURRING_TEMPLATE_RULES = defineFieldRules('expenses.recurringTemplate', {
  name: { label: 'The template name', kind: 'text', requires: 'Give the template a name - "Lipa branch rent", not "expense 3".' },
  supplierId: { label: 'The supplier', kind: 'text', requires: 'Choose the supplier the bill comes from.' },
  categoryId: { label: 'The category', kind: 'text', requires: 'Choose a category.' },
  defaultAmount: { label: 'The default amount', kind: 'money', min: 0.01 },
  anchorDay: { label: 'The day', kind: 'number', integer: true, min: 0, max: 31 },
  startsOn: { label: 'Starts from', optional: true, kind: 'date' },
});
