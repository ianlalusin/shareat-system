'use client';
/**
 * Dialog and FormModal — T-448 (docs/tasks/448-modal-forms-and-density.md).
 *
 * Ian, 2026-10-22: "forms must be hidden always, must only be called by actions like add button, edit
 * update button ... mount all forms on a modal". One modal for the whole app, on the native `<dialog>`:
 * Esc, focus trapping, the top layer and the backdrop come from the browser, so no dependency.
 *
 * The dialog element is always in the DOM (closed when not shown). That keeps every form inside it
 * mounted, so `form.reset()`, refs and server-rendered children behave exactly as they did inline.
 * It is never rendered with the `open` attribute: `showModal()` on an already-open dialog throws.
 */
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import { Button, type ButtonVariant } from './Button';

const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

export type DialogSize = 'sm' | 'md' | 'lg' | 'xl';

export interface DialogProps {
  readonly open: boolean;
  /** Esc, the close button, or a backdrop click. */
  readonly onClose: () => void;
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly size?: DialogSize;
  readonly children?: ReactNode;
  /** Pinned under the body (for example a Retire button that only shows while editing). */
  readonly footer?: ReactNode;
}

export function Dialog({ open, onClose, title, description, size = 'md', children, footer }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useIsomorphicLayoutEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    else if (!open && d.open) d.close();
  }, [open]);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    const onNativeClose = () => onCloseRef.current();
    // Esc fires `cancel`, then `close`; let the browser close it and report through `close`.
    d.addEventListener('close', onNativeClose);
    return () => d.removeEventListener('close', onNativeClose);
  }, []);

  return (
    <dialog
      ref={ref}
      className="erp-dialog"
      data-size={size}
      aria-labelledby={titleId}
      onClick={(e) => {
        // A click on the backdrop lands on the <dialog> itself, never on the panel's children.
        if (e.target === e.currentTarget) e.currentTarget.close();
      }}
    >
      <div className="flex max-h-[inherit] flex-col">
        <div className="flex items-start justify-between gap-4 border-b border-surface-border px-5 py-3">
          <div className="min-w-0">
            <h2 id={titleId} className="text-base font-semibold text-ink">{title}</h2>
            {description ? <p className="mt-0.5 text-xs text-muted">{description}</p> : null}
          </div>
          <button
            type="button"
            data-erp-size="free"
            className="-mr-2 inline-flex h-8 w-8 shrink-0 text-sm items-center justify-center rounded-md text-muted hover:bg-canvas hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink"
            aria-label="Close"
            onClick={() => ref.current?.close()}
          >
            <svg viewBox="0 0 24 24" width={18} height={18} fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" aria-hidden="true" focusable="false">
              <path d="M6 6l12 12M18 6 6 18" />
            </svg>
          </button>
        </div>
        <div className="erp-dialog-body min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer ? <div className="border-t border-surface-border px-5 py-3">{footer}</div> : null}
      </div>
    </dialog>
  );
}

export interface FormModalProps {
  /** The button that opens it: "+ Add supplier", "Log invoice", "Set rate". */
  readonly trigger: ReactNode;
  readonly triggerVariant?: ButtonVariant;
  readonly triggerClassName?: string;
  /** Accessible name for an icon-only or terse trigger. */
  readonly triggerLabel?: string;
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly size?: DialogSize;
  /**
   * Open on arrival. Pass it when the page holds a refill for THIS form (a refused save), so the user
   * lands back in the modal with what they typed and the reason.
   */
  readonly defaultOpen?: boolean;
  readonly children?: ReactNode;
}

/**
 * A trigger button plus a Dialog holding an add/new form. Every server action in this app ends in a
 * redirect with a fresh `?f=` token, so a change of address means the save landed (close) or was
 * refused (the page then passes `defaultOpen` again, and it reopens).
 */
export function FormModal({
  trigger,
  triggerVariant = 'primary',
  triggerClassName,
  triggerLabel,
  title,
  description,
  size,
  defaultOpen = false,
  children,
}: FormModalProps) {
  const [open, setOpen] = useState(defaultOpen);
  const pathname = usePathname();
  const search = useSearchParams();
  const address = `${pathname}?${search?.toString() ?? ''}`;
  const seen = useRef(address);

  useEffect(() => {
    if (seen.current === address) return;
    seen.current = address;
    setOpen(defaultOpen);
  }, [address, defaultOpen]);

  return (
    <>
      <Button
        variant={triggerVariant}
        className={triggerClassName}
        aria-label={triggerLabel}
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
      >
        {trigger}
      </Button>
      <Dialog open={open} onClose={() => setOpen(false)} title={title} description={description} size={size}>
        {children}
      </Dialog>
    </>
  );
}
