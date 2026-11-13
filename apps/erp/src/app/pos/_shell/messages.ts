/** T-526 - the sentences the shell says, in one place so the tests and the screens cannot drift. */
export const POS_NEEDS_INTERNET_ONCE = 'This tablet needs the internet once to load the menu.';
export const POS_TABLET_UNPAIRED_MESSAGE = 'This tablet was un-paired. Ask a manager to pair it again.';
/** The manager-facing sentence from work order T-530a for a conflict the server reports on a sent action. */
export const POS_CONFLICT_MESSAGE = 'A sale number was reused on this tablet. Tell a manager.';
export const POS_WRONG_ID_OR_PIN = 'Wrong Employee ID or PIN.';
export const POS_PIN_PAUSED = 'Too many wrong PINs for this Employee ID. Wait 5 minutes.';
export const POS_OFFLINE_SIGN_IN_EXPIRED = 'Offline sign-in has expired. Connect to the internet and sign in.';
export const POS_STORE_ACCESS_LOST = "You no longer have access to this store's POS.";
/** T-563 R4: sales made under another store's pairing that the server will not take under this one. They stay on the tablet. */
export const posHeldSalesMessage = (n: number): string =>
  `${n} ${n === 1 ? 'sale from another store is' : 'sales from another store are'} waiting on this tablet. Pair it back to that store to send them, or ask a manager.`;
export const posHttpErrorMessage = (status: number): string => `Something went wrong (HTTP ${status}). Tell a manager.`;
