# pos-print — the POS v2 paper documents as plain text

Pure functions that turn already-computed figures into fixed-width lines for a thermal printer:
`formatReceipt`, `formatKitchenTicket` and `formatRefillSlip`, one string per paper line.
No React, no database, no clock (`Date.now()`) and no money arithmetic — every figure and every
formatted date arrives in the arguments, which is what makes each document testable line by line.
Column counts (32/42 for 58 mm, 48/64 for 80 mm) are the only constants here: they are the printer's
file format, not a business value. The ESC/POS byte encoding and the screens that call this come later.
The VAT block under TOTAL prints from `ReceiptView.vat` (computed by `priceSession`); the rate arrives as a label, never typed here.
`adapter.ts` sends lines to `window.ShareatPrinter` (APK plugin) or falls back to the browser's print dialog.
