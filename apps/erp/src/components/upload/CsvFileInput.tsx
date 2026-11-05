'use client';

/**
 * T-502 S4 - a bare picker for a small CSV (text) file. NOT a stored upload: nothing is saved, the server action reads the text
 * once and refuses by size first. Photos and documents use PhotoUpload; the T-441 guard keeps `type="file"` in this folder.
 *
 * T-511 S4: `accept` and `multiple` let the settlement upload take several CSV and zip files in one go (the server still decides what a file is).
 */
export function CsvFileInput({
  name,
  label,
  accept = '.csv,text/csv',
  multiple = false,
}: {
  readonly name: string;
  readonly label: string;
  readonly accept?: string;
  readonly multiple?: boolean;
}) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="font-medium">{label}</span>
      <input type="file" name={name} accept={accept} multiple={multiple} required className="py-2 text-sm" />
    </label>
  );
}
