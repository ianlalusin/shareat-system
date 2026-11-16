/**
 * T-511 S8a - one uploaded file in, one result per INVOICE out. A Foodpanda zip may hold several invoice workbooks (a week of them); each becomes its own
 * upload through `ingestSettlementFile`, in invoice-date order (then invoice number), each in its OWN transaction, so one refused invoice never undoes
 * the others. docs/tasks/511-settlement-upload-s8-spec.md "S8a".
 *
 * Nothing here decides who may upload what: every invoice goes through the same coarse and fine gates as a single file. The one thing done first is the
 * coarse gate, so that a person who may not upload at all gets the usual refusal without the zip being opened.
 *
 * What is stored for a many-invoice zip is a re-packed mini zip per invoice (that workbook + the pdf of the same name, fixed timestamps, CANONICAL member
 * names: the workbook's lower-cased base name, no folder, and the pdf with that same base name; so the same invoice always makes the same bytes and so the
 * same fingerprint, from a re-zipped week, another folder or A.PDF vs a.pdf: uploading again says "already uploaded" for each). A zip with exactly one
 * workbook, a Grab csv, or anything this cannot split goes to `ingestSettlementFile` untouched, with its original bytes.
 *
 * A multi-invoice member and the same workbook uploaded alone as a one-workbook zip (original bytes) have different fingerprints, so the second is not "already
 * uploaded"; since S8b `ingestSettlementFile` supersedes by channel + invoice number (a re-issue), so there is never a second current copy of one invoice.
 */
import { heldCapabilities, type Actor } from '@shareat/auth';
import type { Tx } from '@shareat/db';
import { PURPOSE_LIMITS } from '../files/limits';
import { intakeRefusal, megabytes } from './refusal';
import { fileBytesMatchType } from '../files/magic';
import { readFoodpandaInvoice } from './foodpanda-workbook';
import { ingestSettlementFile, looksZipped, type IngestInput, type IngestResult } from './ingest';
import { openSettlementZipMembers, type SettlementZipMember } from './safe-zip';
import { storedZip } from './zip-repack';

/** Runs `fn` in a transaction of its own (the action's `withOrgPrincipal`). Called once per invoice. */
export type RunInTx = <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>;

export interface UploadMemberResult {
  /** the file's own name, or the workbook's name inside a zip that held several invoices */
  name: string;
  /** read from the workbook; null for a file that is not one invoice, or a workbook that could not be read */
  invoiceNumber: string | null;
  outcome: { ok: true; result: IngestResult } | { ok: false; error: unknown };
}

/** The invoices of a zip worth splitting (two or more workbooks), or null when the file should go through as one. Never throws. */
async function splitOf(run: RunInTx, actor: Actor, bytes: Buffer, contentType: string): Promise<SettlementZipMember[] | null> {
  const limits = PURPOSE_LIMITS.channel_settlement_file;
  if (!looksZipped(bytes) || !limits.types.includes(contentType) || !fileBytesMatchType(contentType, bytes)) return null;
  if (!(await run((tx) => heldCapabilities(tx, actor))).has('upload_settlement_files')) return null;
  try {
    const members = await openSettlementZipMembers(bytes);
    return members.length >= 2 ? members : null;
  } catch {
    return null; // the single-file path raises the same refusal, in its usual place in the order of checks
  }
}

interface Keyed {
  member: SettlementZipMember;
  invoiceNumber: string | null;
  invoiceDate: string | null;
}

/**
 * shortcut: each workbook is read here and again by the ingest (at most 20 per zip). Not passed down: `ingestSettlementFile` is the one place that reads what it
 * stores, and taking a caller's parse of the bytes would let a caller state what a file says. Revisit only if a slow zip ever shows up.
 */
async function keyOf(member: SettlementZipMember): Promise<Keyed> {
  try {
    const invoice = await readFoodpandaInvoice(member.workbook);
    return { member, invoiceNumber: invoice.invoiceNumber, invoiceDate: invoice.invoiceDate };
  } catch {
    return { member, invoiceNumber: null, invoiceDate: null }; // sorts last; the ingest refuses it with its own sentence
  }
}

const NEVER = '￿';
const byInvoice = (a: Keyed, b: Keyed): number =>
  (a.invoiceDate ?? NEVER).localeCompare(b.invoiceDate ?? NEVER) || (a.invoiceNumber ?? NEVER).localeCompare(b.invoiceNumber ?? NEVER);

/** Canonical names (see the header): the folder and the case of how the zip was made never reach the stored bytes. */
function miniZip(m: SettlementZipMember): Buffer {
  const base = (m.name.split('/').pop() ?? m.name).replace(/\.xls$/i, '').toLowerCase();
  return storedZip([{ name: `${base}.xls`, data: m.workbook }, ...(m.pdf ? [{ name: `${base}.pdf`, data: m.pdf }] : [])]);
}

export async function ingestSettlementUpload(run: RunInTx, actor: Actor, input: IngestInput): Promise<UploadMemberResult[]> {
  const bytes = Buffer.isBuffer(input.bytes) ? input.bytes : Buffer.from(input.bytes);
  const members = await splitOf(run, actor, bytes, input.contentType);
  if (members === null) {
    try {
      return [{ name: input.fileName ?? 'file', invoiceNumber: null, outcome: { ok: true, result: await run((tx) => ingestSettlementFile(tx, actor, input)) } }];
    } catch (error) {
      return [{ name: input.fileName ?? 'file', invoiceNumber: null, outcome: { ok: false, error } }];
    }
  }
  const keyed: Keyed[] = [];
  for (const m of members) keyed.push(await keyOf(m));
  keyed.sort(byInvoice); // stable: members with no readable date keep the zip's order
  const out: UploadMemberResult[] = [];
  for (const { member, invoiceNumber } of keyed) {
    try {
      const mini = miniZip(member);
      const limit = PURPOSE_LIMITS.channel_settlement_file.maxBytes;
      if (mini.length > limit) {
        throw intakeRefusal('FILE_TOO_BIG', `This invoice's files together are ${megabytes(mini.length)} MB, over the ${limit / (1024 * 1024)} MB limit.`);
      }
      const result = await run((tx) => ingestSettlementFile(tx, actor, { bytes: mini, contentType: input.contentType, fileName: member.name }));
      out.push({ name: member.name, invoiceNumber, outcome: { ok: true, result } });
    } catch (error) {
      out.push({ name: member.name, invoiceNumber, outcome: { ok: false, error } });
    }
  }
  return out;
}
