/**
 * T-440 field rules for app/trade: the new-order form, dispatch (paid on the spot), receipt, void, and customer returns.
 * The per-line boxes (item, quantity, rate; the signed-for quantity) repeat under one name per row, so they are a
 * repeated-line family (S8) and are not in these sets.
 */
import { defineFieldRules } from './check';

/** "New trade order" header fields (createOrderAction). */
export const TRADE_ORDER_RULES = defineFieldRules('trade.createTradeOrder', {
  storeId: { label: 'The selling store', kind: 'text', requires: 'Choose the selling store.' },
  customerId: { label: 'The customer', kind: 'text', requires: 'Choose a customer.' },
  orderDate: { label: 'The order date', kind: 'date' },
  deliveryFee: { label: 'The delivery fee', optional: true, kind: 'money', min: 0 },
  otherFees: { label: 'The other fees', optional: true, kind: 'money', min: 0 },
});

/** "Paid on the spot?" at dispatch (dispatchOrderAction). The account is asked only when an amount is typed: that stays the domain's. */
export const TRADE_DISPATCH_RULES = defineFieldRules('trade.dispatchTradeOrder', {
  payNowAmount: { label: 'The amount paid now', optional: true, kind: 'money', min: 0.01 },
});

/** "Received on" (receiveOrderAction). Blank means today, so it is optional. */
export const TRADE_RECEIVE_RULES = defineFieldRules('trade.receiveTradeOrder', {
  receivedOn: { label: 'The received-on date', optional: true, kind: 'date' },
});

/** "Void — say why" on a trade order (voidOrderAction). */
export const TRADE_VOID_RULES = defineFieldRules('trade.voidTradeOrder', {
  reason: { label: 'The void reason', kind: 'text', requires: 'Say why this order is being voided.' },
});

/** "Return" on a returnable line (recordReturnAction). A quantity has at most three decimals and must not be zero. */
export const RETURN_RECORD_RULES = defineFieldRules('trade.recordCustomerReturn', {
  quantity: {
    label: 'The quantity returned',
    kind: 'pattern',
    pattern: '^(?=.*[1-9])\\d*(?:\\.\\d{1,3})?$',
    patternSays: 'a quantity greater than zero with up to three decimal places',
  },
  reason: { label: 'The reason', kind: 'text' },
});

/** "void reason" beside a posted return (voidReturnAction). */
export const RETURN_VOID_RULES = defineFieldRules('trade.voidCustomerReturn', {
  reason: { label: 'The void reason', kind: 'text', requires: 'Say why this return is being voided.' },
});
