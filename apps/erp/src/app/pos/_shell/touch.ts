/**
 * T-526b - the POS touch size, one place. `min-h-12` / `min-w-12` are 3rem (48 px) from the spacing scale, never a raw pixel value.
 *
 * ⚠️ `data-erp-size="free"` is the opt-out from globals.css's compact-control rule (32 px on a mouse, inside `.erp-page` and `.erp-dialog`): without it a
 * dialog's keys and buttons are squeezed to text height (the render measured the keypad at 37 px). The POS shell sets it on every key it draws in a dialog.
 */
export const POS_TOUCH = 'min-h-12 min-w-12';

/**
 * The switch-cashier dialog's Sign in. The kit's disabled style is `opacity-50`, which put white on pale pink (~2:1). Scoped to this button, NOT the kit:
 * disabled is a flat `muted` fill with `canvas` text, both tokens, so it is 5.68:1 in light and higher in dark (apps/erp/tests/theme-tokens.test.ts holds the pair).
 */
export const POS_SIGN_IN_BUTTON = `${POS_TOUCH} w-full justify-center disabled:!opacity-100 disabled:!bg-muted disabled:!text-canvas disabled:cursor-not-allowed`;
