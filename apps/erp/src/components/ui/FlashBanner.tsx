/**
 * FlashBanner — T-387 S3. Renders `error`, `warning` and `notice` from a `withFlash` result as Banners, in that
 * order. `ok` is deliberately NOT rendered: the Toaster shows it (S4).
 * `Flash` is a type-only import: the flash module pulls `next/headers` into every render.
 */
import type { Flash } from '@/lib/flash';
import { Banner } from './Banner';

export function FlashBanner({
  flash,
  fieldLabels,
}: {
  readonly flash: Pick<Flash, 'error' | 'warning' | 'notice' | 'field'>;
  /** T-387 S4: element id -> label. A refusal that names a `field` links to it only when its label is listed here. */
  readonly fieldLabels?: Readonly<Record<string, string>>;
}) {
  const label = flash.field ? fieldLabels?.[flash.field] : undefined;
  return (
    <>
      {flash.error ? <span hidden data-form-refusal="true" /> : null}
      {flash.error ? (
        label && flash.field ? (
          <Banner tone="error" fieldId={flash.field} fieldLabel={label}>
            {flash.error}
          </Banner>
        ) : (
          <Banner tone="error">{flash.error}</Banner>
        )
      ) : null}
      {flash.warning ? <Banner tone="warning">{flash.warning}</Banner> : null}
      {flash.notice ? <Banner tone="info">{flash.notice}</Banner> : null}
    </>
  );
}
