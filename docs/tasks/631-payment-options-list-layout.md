# T-631 - Payment options: one compact list

Page: `/settings/pos-link`, card "Payment options (all stores)" (`PaymentOptionsSection`).
Status: built on `feat/t631-payment-options-ui`, not pushed.

## Brief (BOSS ruling, from Ian's screenshot)

Problems: each of the 7 options was a label plus a sentence plus a big dark Edit button (~95px a row, the label seven times, seven heavy buttons competing with the red "+ Add payment option"); the badge said "7 in use" though only options switched on at a store are in use; "wallet" reads oddly for cards; options used at 0 stores looked like used ones.

1. Active options render as ONE house `Table`: Payment option (medium weight) / Type ("Cash" or "Paid to an account", small neutral pill; stored kind stays cash/wallet) / Stores using (right-aligned tabular number; 0 muted, "Not used yet") / a quiet Edit at the row end. Editing keeps every action, rule and domain call: name, kind only while unused, Retire with the same consequence text.
2. Badge: "{used} of {total} used at a store" (used = storesOn > 0).
3. Keep the description and the red "+ Add payment option". Add dialog Kind labels: "Cash (money in the till)" and "Paid to an account (e-wallet, bank, card)". Values unchanged.
4. Phone (390px): the existing phone-table-cards behaviour makes two-line cards; no sideways scroll; tap targets >= 44px.
5. Retired list unchanged apart from the type wording.
Out of scope: the store cards below (observation only).

## As built

- `apps/erp/src/components/forms/EditableRecord.tsx`: new optional `quiet` prop. Locked trigger becomes an outlined 44px "Edit" (QUIET_BTN) instead of the ink-filled one. Default look of every other EditableRecord is unchanged.
- `apps/erp/src/app/settings/pos-link/page.tsx`: `KIND_TEXT.wallet` is now "Paid to an account"; list is a `Table` (card metadata: title Payment option, subtitle Type, key Stores using) with each row's `EditableRecord quiet` inside a `data-card-ignore` cell (same pattern as money-accounts); Add and Edit selects use the long labels; field label "Kind" is now "Type".
- Not changed: actions, domain calls, `SETTINGS_PAYMENT_OPTION_RULES` (its "cash or a wallet" refusal sentence still says wallet; a domain wording change is a separate call), TendersSection (store cards).
