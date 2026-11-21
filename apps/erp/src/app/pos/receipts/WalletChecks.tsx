'use client';

/**
 * T-623 - "Wallet payments to check (n)" on /pos/receipts, for a person who holds `approve_pos_correction` (the page hides it otherwise). Each row has a Checked button with a light
 * confirm: the manager saw the money arrive under that reference, and a check cannot be undone. Pure presentation: the server (`checkWalletPayment`) judges and answers with its own
 * sentence. Online only (a server action): offline the buttons are off and the section says "Needs the internet.".
 */
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Banner, Dialog, Table, Td, NumTd, Th } from '@/components/ui';
import { peso } from '@/lib/format';
import { usePos } from '../_shell/pos-context';
import { checkWalletPaymentAction, type CheckResult } from './actions';

export const CHECK_NEEDS_INTERNET = 'Needs the internet.';

export interface PaymentToCheck {
  paymentId: string;
  receiptNo: string;
  /** Formatted on the server (Manila time). */
  when: string;
  tenderName: string;
  amount: string;
  referenceNo: string;
}
export type CheckPayment = (input: { storeId: string; paymentId: string }) => Promise<CheckResult>;

// Plain literals: the touch-target census reads them.
const PRIMARY = 'min-h-16 inline-flex w-full items-center justify-center rounded-full border border-transparent bg-brand px-6 text-base font-semibold text-white hover:bg-brand-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink disabled:opacity-50';
const SECONDARY = 'min-h-12 min-w-12 inline-flex items-center justify-center gap-2 rounded-full border border-surface-border bg-surface px-4 text-base font-semibold text-ink hover:bg-canvas focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink disabled:opacity-50';

/** The words of the confirm. Pure. */
export const confirmText = (p: Pick<PaymentToCheck, 'amount' | 'tenderName' | 'referenceNo'>): string =>
  `Mark ${peso(p.amount)} ${p.tenderName} ref ${p.referenceNo} as checked? You saw it arrive. This cannot be undone.`;

export function WalletChecks({ storeId, payments, check }: { storeId: string; payments: readonly PaymentToCheck[]; check?: CheckPayment }) {
  const router = useRouter();
  const online = usePos()?.online ?? true;
  const [asking, setAsking] = useState<PaymentToCheck | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const close = () => {
    setAsking(null);
    setProblem(null);
  };
  const confirm = async () => {
    if (!asking || busy) return;
    setBusy(true);
    try {
      const answer = await (check ?? checkWalletPaymentAction)({ storeId, paymentId: asking.paymentId });
      if (answer.ok) {
        close();
        router.refresh();
      } else setProblem(answer.error);
    } catch {
      setProblem('The payment could not be marked as checked. Check the internet and try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="space-y-2" aria-label="Wallet payments to check">
      <h2 className="text-lg font-semibold">Wallet payments to check ({payments.length})</h2>
      <p className="text-sm text-muted">Taken without the internet. Check the store&apos;s wallet account for the reference, then tap Checked. If it did not arrive, use Wrong payment method on that receipt instead.</p>
      {online ? null : <p className="text-sm text-muted">{CHECK_NEEDS_INTERNET}</p>}
      {payments.length === 0 ? (
        <p className="text-sm text-muted">Nothing to check in the last 7 days.</p>
      ) : (
        <Table label="Wallet payments to check">
          <thead>
            <tr>
              <Th>Time</Th>
              <Th>Receipt no</Th>
              <Th>Paid by</Th>
              <Th numeric>Amount</Th>
              <Th>Reference</Th>
              <Th>Check</Th>
            </tr>
          </thead>
          <tbody>
            {payments.map((p) => (
              <tr key={p.paymentId}>
                <Td>{p.when}</Td>
                <Td className="font-mono">{p.receiptNo}</Td>
                <Td>{p.tenderName}</Td>
                <NumTd>{peso(p.amount)}</NumTd>
                <Td className="font-mono">{p.referenceNo}</Td>
                <Td>
                  <button type="button" data-erp-size="free" className={SECONDARY} disabled={!online} aria-disabled={!online} onClick={() => setAsking(p)}>
                    Checked
                  </button>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      <Dialog open={asking !== null} onClose={close} title="Mark as checked" size="sm">
        <div className="space-y-4 p-5">
          <p className="text-base text-ink">{asking ? confirmText(asking) : ''}</p>
          {problem ? <Banner tone="error">{problem}</Banner> : null}
          <button type="button" data-erp-size="free" className={PRIMARY} disabled={busy} aria-disabled={busy} onClick={() => void confirm()}>
            {busy ? 'Saving…' : 'Yes, mark as checked'}
          </button>
        </div>
      </Dialog>
    </section>
  );
}

/** The section as the page draws it: only for a person who holds the right (the server decides `canCheck`); nobody else gets even the heading. */
export function WalletChecksSection({ canCheck, ...rest }: { canCheck: boolean; storeId: string; payments: readonly PaymentToCheck[]; check?: CheckPayment }) {
  return canCheck ? <WalletChecks {...rest} /> : null;
}
