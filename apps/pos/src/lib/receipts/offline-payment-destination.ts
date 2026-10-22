/** The sale is already durable. An optional print preference cannot change its outcome. */
export async function offlinePaymentDestination(
  receiptId: string,
  readSettings: () => Promise<{ autoPrintAfterPayment?: unknown } | null>,
  warn: (error: unknown) => void,
): Promise<string> {
  let autoPrint = false;
  try { autoPrint = (await readSettings())?.autoPrintAfterPayment === true; }
  catch (error) { warn(error); } // preference unknown: manual print for this receipt, no settings write
  return `/receipt?id=${encodeURIComponent(receiptId)}${autoPrint ? '&autoprint=1' : ''}`;
}
