/**
 * FlashBanner — T-387 S3. Renders `error`, `warning` and `notice` from a `withFlash` result as Banners, in that
 * order. `ok` is deliberately NOT rendered: the Toaster shows it (S4).
 * `Flash` is a type-only import: the flash module pulls `next/headers` into every render.
 */
import type { Flash } from '@/lib/flash';
import { Banner } from './Banner';

export function FlashBanner({ flash }: { readonly flash: Pick<Flash, 'error' | 'warning' | 'notice'> }) {
  return (
    <>
      {flash.error ? <Banner tone="error">{flash.error}</Banner> : null}
      {flash.warning ? <Banner tone="warning">{flash.warning}</Banner> : null}
      {flash.notice ? <Banner tone="info">{flash.notice}</Banner> : null}
    </>
  );
}
