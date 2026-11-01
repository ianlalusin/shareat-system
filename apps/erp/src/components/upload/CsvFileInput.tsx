'use client';

/**
 * T-502 S4 - a bare picker for a small CSV (text) file. NOT a stored upload: nothing is saved, the server action reads the text
 * once and refuses by size first. Photos and documents use PhotoUpload; the T-441 guard keeps `type="file"` in this folder.
 */
export function CsvFileInput({ name, label }: { readonly name: string; readonly label: string }) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="font-medium">{label}</span>
      <input type="file" name={name} accept=".csv,text/csv" required className="py-2 text-sm" />
    </label>
  );
}
