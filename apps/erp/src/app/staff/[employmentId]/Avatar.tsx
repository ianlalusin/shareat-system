import { PhotoThumb } from '@/components/upload/PhotoThumb';

/** The staff photo (opens full size), or the initials on a neutral circle. `inLink`: drawn inside a button, so no full-size view. */
export function Avatar({ name, photoFileId, inLink = false }: { name: string; photoFileId: string | null; inLink?: boolean }) {
  if (photoFileId) {
    return (
      <PhotoThumb purpose="staff_photo" label={name} existing={{ fileId: photoFileId, kind: 'image' }} size="fill" className="h-16 w-16" inLink={inLink} />
    );
  }
  const initials = name
    .split(/[\s,]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w.charAt(0).toUpperCase())
    .join('');
  return (
    <span aria-hidden="true" className="inline-flex h-16 w-16 shrink-0 items-center justify-center rounded-full bg-neutral-200 text-lg font-semibold text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300">
      {initials}
    </span>
  );
}
