/**
 * DEF-531: the supplier edit form's plain fields. Not a `'use server'` file, so a test can import it.
 * A key the form never sent is `undefined` (`editSupplier` leaves the column alone), never `''` or a default,
 * so a partial edit form cannot clear an address or reactivate a deactivated supplier.
 */
export function supplierPlainFieldsFrom(fd: FormData) {
  const read = (k: string): string | undefined => {
    const v = fd.get(k);
    return typeof v === 'string' ? v.trim() : undefined;
  };
  const textOrNull = (k: string) => (fd.has(k) ? read(k) || null : undefined);
  return {
    address: textOrNull('address'),
    contactNo: textOrNull('contactNo'),
    notes: textOrNull('notes'),
    vatStatus: (fd.has('vatStatus') ? read('vatStatus') || null : undefined) as never,
    status: (read('status') || undefined) as never,
  };
}
