import { auditDayOf } from '../pos2-audit-lib.mjs';

/** Pure receipt projection; full identities are emitted only by the explicitly requested logbook. */
export function statutoryLogbookRows(storeId, receipts, range) {
  const refunded = new Set(receipts.filter(receipt => receipt.data.isRefund === true).map(receipt => receipt.data.parentReceiptId));
  return receipts.filter(receipt => !receipt.data.isRefund && Number.isFinite(Number(receipt.data.createdAtClientMs))
    && Number(receipt.data.createdAtClientMs) >= range.fromMs && Number(receipt.data.createdAtClientMs) <= range.toMs)
    .sort((a, b) => Number(a.data.createdAtClientMs) - Number(b.data.createdAtClientMs)
      || String(a.data.receiptNumber ?? a.id).localeCompare(String(b.data.receiptNumber ?? b.id)))
    .flatMap(receipt => {
      const data = receipt.data, day = auditDayOf(Number(data.createdAtClientMs));
      return (data.statutoryDiners ?? []).map(diner => ({ store: storeId, date: `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}`,
        receipt: String(data.receiptNumber ?? receipt.id), kind: diner.kind, name: diner.name, idNo: diner.idNo,
        share: diner.share, discount: diner.discount, vatExempt: diner.vatExempt, vatRemoved: diner.vatRemoved,
        refunded: data.refundCount > 0 || data.totalRefunded > 0 || refunded.has(receipt.id) }));
    });
}
const csv = value => {
  const text = String(value ?? '');
  // Management spreadsheet view: quoted tab prefix keeps formula-looking text literal.
  // Raw receipt identity fields are unchanged; numeric columns never pass through this helper.
  const guarded = /^[\s]*[=+\-@＝＋－＠]/u.test(text) || /^[\t\r\n]/.test(text);
  const literal = guarded ? `\t${text}` : text;
  return guarded || /[,"\r\n]/.test(literal) ? `"${literal.replace(/"/g, '""')}"` : literal;
};
const amount = value => {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('A statutory receipt has an invalid amount. Correct it before exporting.');
  return value.toFixed(2);
};
export function renderStatutoryLogbook(rows, range) {
  return ['Contains personal data. Management record, not a BIR document (row 75).',
    'store,date,receipt,kind,name,idNo,share,discount,vatExempt,vatRemoved,refunded',
    ...rows.map(row => [row.store, row.date, row.receipt, row.kind, row.name, row.idNo].map(csv)
      .concat([amount(row.share), amount(row.discount), amount(row.vatExempt), amount(row.vatRemoved), row.refunded ? 'yes' : 'no']).join(',')),
    `statutory-logbook: ${rows.length} diner(s) for ${range.from} to ${range.to}.`, ''].join('\n');
}
