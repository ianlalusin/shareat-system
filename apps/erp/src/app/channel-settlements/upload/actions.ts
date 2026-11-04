'use server';

/**
 * T-511 S4 - /channel-settlements/upload server action. The gate is the domain's (`ingestSettlementFile` checks the capability, then the
 * MATCHED store); nothing here decides who may upload what. One database transaction per file, so a refused file rolls back alone and the
 * answer is a line per file: staged, already uploaded, or a plain sentence saying why not.
 */
import { ingestSettlementFile, type IngestResult } from '@shareat/domain';
import { requireActor } from '../../../lib/session';
import { errorMessage } from '@/lib/constraint-messages';
import { withOrgPrincipal } from '../lib';

/** A bigger batch is split by the person, not by the server. */
const MAX_FILES = 10;
const MAX_FILE_BYTES = 3 * 1024 * 1024;

export interface UploadLine {
  name: string;
  ok: boolean;
  /** what the file turned out to be and what happened to it, or the reason it was refused */
  message: string;
  warnings: string[];
}
export type UploadReport = { ok: true; lines: UploadLine[] } | { ok: false; error: string };

const KIND_LABEL: Record<IngestResult['kind'], string> = {
  foodpanda_invoice: 'Foodpanda invoice',
  grab_transactions: 'Grab Transactions file',
  grab_transfers: 'Grab Transfers file',
};
const days = (n: number): string => `${n} day${n === 1 ? '' : 's'}`;

function describe(r: IngestResult): string {
  const what = `${KIND_LABEL[r.kind]} for ${r.storeName}`;
  if (r.alreadyUploaded) return `${what}: already uploaded on ${r.uploadedOn}. Nothing changed.`;
  if (r.waitingFor !== null) return `${what}: saved, nothing staged yet.`;
  const parts = [`${days(r.daysStaged)} staged`];
  if (r.daysUnchanged > 0) parts.push(`${days(r.daysUnchanged)} already the same`);
  if (r.waitingForRows > 0) parts.push(`${r.waitingForRows} payout${r.waitingForRows === 1 ? '' : 's'} wait for rows from the month before`);
  return `${what}: ${parts.join(', ')}.`;
}

export async function uploadSettlementFilesAction(formData: FormData): Promise<UploadReport> {
  const actor = await requireActor();
  const files = formData.getAll('files').filter((f): f is File => f instanceof File && f.size > 0);
  if (files.length === 0) return { ok: false, error: 'Choose the Grab or Foodpanda files to upload first.' };
  if (files.length > MAX_FILES) return { ok: false, error: `Upload at most ${MAX_FILES} files at a time.` };
  const lines: UploadLine[] = [];
  for (const file of files) {
    if (file.size > MAX_FILE_BYTES) {
      lines.push({ name: file.name, ok: false, message: 'This file is larger than 3 MB, the most one settlement file can be.', warnings: [] });
      continue;
    }
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const r = await withOrgPrincipal(actor.orgId, (tx) => ingestSettlementFile(tx, actor, { contentType: file.type, bytes, fileName: file.name }));
      lines.push({ name: file.name, ok: true, message: describe(r), warnings: r.warnings });
    } catch (err) {
      lines.push({ name: file.name, ok: false, message: errorMessage(err), warnings: [] });
    }
  }
  return { ok: true, lines };
}
