'use client';

/**
 * T-511 S4 - the drop zone of /channel-settlements/upload. Sends the chosen files to the server action and shows one line per file:
 * what it was, which store, how many days were staged, any warnings, or the plain sentence saying why it was refused. Holds no data of its own.
 */
import { useState, type FormEvent } from 'react';
import { Banner, Button } from '@/components/ui';
import { CsvFileInput } from '@/components/upload/CsvFileInput';
import { uploadSettlementFilesAction, type UploadReport } from './actions';

/** Each file is up to 3 MB and a batch travels in one request, so a batch stays small. */
const MAX_FILES_PER_BATCH = 6;

export function UploadForm() {
  const [report, setReport] = useState<UploadReport | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    if (formData.getAll('files').length > MAX_FILES_PER_BATCH) {
      setReport({ ok: false, error: `Choose at most ${MAX_FILES_PER_BATCH} files at a time. Upload the rest in a second go.` });
      return;
    }
    setPending(true);
    try {
      setReport(await uploadSettlementFilesAction(formData));
    } catch {
      setReport({ ok: false, error: 'The upload could not be sent. Try fewer files at a time (each file is up to 3 MB; a batch is limited to about 20 MB).' });
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="space-y-6">
      <form onSubmit={onSubmit} className="flex flex-wrap items-end gap-3">
        <CsvFileInput name="files" label="Grab CSV files and Foodpanda zips" accept=".csv,.zip,text/csv,application/zip" multiple />
        <Button type="submit" disabled={pending}>
          Upload the files
        </Button>
        {pending ? <span role="status" className="text-sm">Reading the files…</span> : null}
      </form>
      {report && !report.ok ? <Banner tone="error">{report.error}</Banner> : null}
      {report && report.ok ? (
        <ul className="space-y-3" aria-label="Result of each file">
          {report.lines.map((l, i) => (
            <li key={`${l.name}-${i}`} className="space-y-1">
              <Banner tone={l.ok ? 'success' : 'error'}>
                <strong>{l.name}</strong>: {l.message}
              </Banner>
              {l.warnings.map((w) => (
                <p key={w} className="pl-3 text-sm">
                  {w}
                </p>
              ))}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
