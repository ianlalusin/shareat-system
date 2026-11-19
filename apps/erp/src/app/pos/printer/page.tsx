import { requirePageAccess } from '@/lib/page-access';
import { Page } from '@/components/shell/Page';
import { PrinterScreen } from '../_printer/PrinterScreen';

export const metadata = { title: 'Printer — Shareat POS' };
export const dynamic = 'force-dynamic';

/** T-532 S1: /pos/printer inherits `/pos` (record_sale) by prefix. A device setting, not money: no store check, no write on the server. */
export default async function PosPrinterPage() {
  const { refusal } = await requirePageAccess('/pos/printer');
  if (refusal) return refusal;
  return (
    <Page density="table">
      <PrinterScreen />
    </Page>
  );
}
