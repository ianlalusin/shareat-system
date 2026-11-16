'use server';

/**
 * T-511 S4 - /channel-settlements/upload server action. The gate is the domain's (`ingestSettlementFile` checks the capability, then the
 * MATCHED store); nothing here decides who may upload what. One database transaction per file, so a refused file rolls back alone and the
 * answer is a line per file: staged, already uploaded, or a plain sentence saying why not.
 * T-511 S8a: a Foodpanda zip holding several invoices is split by the domain (`ingestSettlementUpload`) into one upload per invoice, each in its
 * own transaction; the answer is then a line per INVOICE, in the order they were read, and one refused invoice never undoes the others.
 */
import { ingestSettlementUpload, PURPOSE_LIMITS, shown, type IngestResult, type UploadMemberResult } from '@shareat/domain';
import { requireActor } from '../../../lib/session';
import { errorMessage } from '@/lib/constraint-messages';
import { withOrgPrincipal } from '../lib';

/** A bigger batch is split by the person, not by the server. */
const MAX_FILES = 10;
// the one place the cap lives: files/limits.ts (ingestSettlementFile enforces the same figure)
const MAX_MB = PURPOSE_LIMITS.channel_settlement_file.maxBytes / (1024 * 1024);

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
  if (r.waitingFor !== null) return `${what}: saved, nothing loaded yet.`;
  const parts = [`${days(r.daysStaged)} loaded`];
  if (r.daysUnchanged > 0) parts.push(`${days(r.daysUnchanged)} already the same`);
  if (r.waitingForRows > 0) parts.push(`${r.waitingForRows} payout${r.waitingForRows === 1 ? '' : 's'} wait for rows from the month before`);
  return `${what}: ${parts.join(', ')}.`;
}

/** A line for one invoice of a many-invoice zip: plain words, the invoice number first. */
function describeInvoice(r: IngestResult, invoiceNumber: string | null): string {
  const who = `${invoiceNumber === null ? 'Invoice' : `Invoice ${shown(invoiceNumber)}`} for ${r.storeName}`;
  if (r.alreadyUploaded) return `${who}: already uploaded on ${r.uploadedOn}. Nothing changed.`;
  if (r.daysStaged === 0 && r.daysUnchanged === 0) return `${who}: added. It holds only charges, so there are no sales days to review.`;
  const parts = [r.daysStaged === 0 ? 'no new days to review' : `${days(r.daysStaged)} ready to review`];
  if (r.daysUnchanged > 0) parts.push(`${days(r.daysUnchanged)} already the same as before`);
  return `${who}: added, ${parts.join(', ')}.`;
}

function lineOf(fileName: string, many: boolean, m: UploadMemberResult): UploadLine {
  if (!many) {
    return m.outcome.ok
      ? { name: fileName, ok: true, message: describe(m.outcome.result), warnings: m.outcome.result.warnings }
      : { name: fileName, ok: false, message: errorMessage(m.outcome.error), warnings: [] };
  }
  // names come from inside the file the person chose: the same sanitiser as the sentences (one line, cut at 40, no ids)
  const name = `${shown(m.name)} (in ${shown(fileName)})`;
  if (m.outcome.ok) return { name, ok: true, message: describeInvoice(m.outcome.result, m.invoiceNumber), warnings: m.outcome.result.warnings };
  const who = m.invoiceNumber === null ? '' : `Invoice ${shown(m.invoiceNumber)}. `;
  return { name, ok: false, message: `${who}Not added. ${errorMessage(m.outcome.error)}`, warnings: [] };
}

export async function uploadSettlementFilesAction(formData: FormData): Promise<UploadReport> {
  const actor = await requireActor();
  const files = formData.getAll('files').filter((f): f is File => f instanceof File && f.size > 0);
  if (files.length === 0) return { ok: false, error: 'Choose the Grab or Foodpanda files to upload first.' };
  if (files.length > MAX_FILES) return { ok: false, error: `Upload at most ${MAX_FILES} files at a time.` };
  const lines: UploadLine[] = [];
  for (const file of files) {
    if (file.size > PURPOSE_LIMITS.channel_settlement_file.maxBytes) {
      lines.push({ name: file.name, ok: false, message: `This file is larger than ${MAX_MB} MB, the most one settlement file can be.`, warnings: [] });
      continue;
    }
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const members = await ingestSettlementUpload((fn) => withOrgPrincipal(actor.orgId, fn), actor, { contentType: file.type, bytes, fileName: file.name });
      for (const m of members) lines.push(lineOf(file.name, members.length > 1, m));
    } catch (err) {
      lines.push({ name: file.name, ok: false, message: errorMessage(err), warnings: [] });
    }
  }
  return { ok: true, lines };
}
