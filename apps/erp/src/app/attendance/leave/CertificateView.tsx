'use client';

/**
 * T-441 S4 - the certificate viewer: opens the shared Lightbox on the audited file route. The id arrives only from the deciding loader
 * (`loadProofFileId`); there is no thumbnail, nothing is fetched until the button is pressed, and each open is one audited view
 * (the Lightbox adds a fresh `?open=` to the address, and its picture exists only while it is open).
 */
import { Lightbox, useLightbox } from '@/components/upload/Lightbox';
import { Button } from '@/components/ui';

export function CertificateView({ fileId }: { fileId: string }) {
  const lightbox = useLightbox();
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-xs text-neutral-500">Proof attached</span>
      <Button type="button" variant="secondary" onClick={lightbox.show}>
        View certificate
      </Button>
      <Lightbox open={lightbox.open} count={lightbox.count} onClose={lightbox.hide} label="Medical certificate" fileId={fileId} kind="image" />
    </div>
  );
}
