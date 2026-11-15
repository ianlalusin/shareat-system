/**
 * T-585 R1 - who a POS receipt or slip says issued it: the org's registered name, its TIN with this store's branch, and the store's address and contact.
 * Pure. A missing value yields NOTHING (no line, no placeholder). The TIN is stored as digits (`organizations_tin_format_check`), so grouping it in threes here is display only.
 */
export interface ReceiptIdentity {
  businessName: string;
  addressLines: string[];
  tin: string | null;
}

const clean = (s: string | null | undefined): string => (s ?? '').trim();

export function receiptIdentityOf(
  org: { name: string; legalName: string | null; tin: string | null },
  store: { tinBranchCode: string | null; address: string | null; contactNumber: string | null },
): ReceiptIdentity {
  const digits = clean(org.tin);
  const branch = clean(store.tinBranchCode);
  const group = (d: string) => d.replace(/(\d{3})(?=\d)/g, '$1-');
  const grouped = group(digits); // a 12-digit TIN already carries a branch (head office 000): with a store branch only its first 9 digits print (coordinator ruling).
  // shortcut: groups of 3 from the left, no house formatter exists; upgrade if BIR layout is ever required
  return {
    businessName: clean(org.legalName) || org.name,
    addressLines: [...clean(store.address).split(/\r?\n/), clean(store.contactNumber)].map(clean).filter((l) => l !== ''),
    tin: digits === '' ? null : branch === '' ? grouped : `${group(digits.slice(0, 9))}-${branch}`,
  };
}
