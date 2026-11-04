/**
 * T-511 S4 - ingest one Grab or Foodpanda settlement file into the staging tables. docs/tasks/511-settlement-upload-s4-spec.md "ingest.ts".
 * Nothing is booked: the file is read, matched to its channel, stored as evidence and turned into staged lines (a person reviews them in a later slice).
 *
 * ORDER (BOSS 4 Nov): coarse gate (holds the capability at all) -> size, type, magic bytes -> kind from the CONTENT -> read -> match the store ->
 * fine gate on the MATCHED store -> repeat-fingerprint lookup -> stage and check -> store the file under the matched store -> write. The repeat
 * lookup comes after the fine gate, so a manager of one store never learns that another store's file exists or when it was uploaded.
 *
 * One call is one transaction (the caller opens it), so a refused file leaves no row, no stored file and no audit entry. A Grab file pairs with its
 * counterpart: Transfers and Transactions say different things, and a payout stages only when both are in. On every Grab upload EVERY current upload
 * of the other kind is read back from storage with the same reader and merged by settlement id (the newest wins), then the two sides are tied again,
 * so replacing either file re-matches the days it touches. A counterpart that cannot be read back is skipped with a warning, never a refusal.
 */
import { createHash } from 'node:crypto';
import { authorize, AuthorizationError, heldCapabilities, type Actor } from '@shareat/auth';
import { advisoryLocksRepo, auditLogRepo, filesRepo, settlementIntakeRepo, type SettlementDayLineRow, type SettlementUploadRow, type Tx } from '@shareat/db';
import { parseCsv } from '@shareat/core/csv';
import { ZERO, subtract, type Money } from '@shareat/core/money';
import { uploadFile } from '../files';
import { resolveStorageDriver } from '../files/driver';
import { PURPOSE_LIMITS } from '../files/limits';
import { fileBytesMatchType } from '../files/magic';
import { decodeGrabText, csvFailure } from './grab-csv';
import { tieGrabPayouts } from './grab-payouts';
import { GRAB_TRANSACTION_HEADERS, readGrabTransactions, type GrabTransactionsFile } from './grab-transactions';
import { GRAB_TRANSFER_HEADERS, readGrabTransfers, type GrabTransferRow, type GrabTransfersFile } from './grab-transfers';
import { readFoodpandaInvoice } from './foodpanda-workbook';
import { intakeRefusal, megabytes, shown } from './refusal';
import { openSettlementZip } from './safe-zip';
import { checkStagedDay, checkStagedPeriodLines, stageFoodpandaDays, stageGrabDays, type StagedDay, type StagedFile } from './stage';
import { matchChannel, refuseIfInactive, type MatchedChannel } from './store-match';
import { READER_VERSION } from './version';

export type SettlementFileKind = 'foodpanda_invoice' | 'grab_transactions' | 'grab_transfers';

export interface IngestInput {
  bytes: Buffer | Uint8Array;
  /** what the browser said the file is; checked against the first bytes, never trusted */
  contentType: string;
  /** shown nowhere and never decides the kind (a file called "Transfers.csv" is read by its content) */
  fileName?: string;
}

export interface IngestResult {
  kind: SettlementFileKind;
  platform: 'grab' | 'foodpanda';
  channelId: string;
  storeId: string;
  storeName: string;
  uploadId: string;
  /** the same bytes were uploaded before: nothing was written, `uploadId` is the earlier upload */
  alreadyUploaded: boolean;
  /** the earlier upload's Manila date, only when `alreadyUploaded` */
  uploadedOn: string | null;
  /** day-line versions this call wrote */
  daysStaged: number;
  daysUnchanged: number;
  /** Grab payouts present but with no rows in the Transactions file */
  waitingForRows: number;
  /** Grab: which file this one is still waiting for */
  waitingFor: 'transfers_file' | 'transactions_file' | null;
  warnings: string[];
}

export const fingerprintOf = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

const asBuffer = (bytes: Uint8Array): Buffer => (Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes));

const starts = (bytes: Uint8Array, sig: readonly number[]): boolean => sig.every((b, i) => bytes[i] === b);
/** ZIP local-file-header, empty archive and spanned archive: all go to the zip reader, which names what is wrong with them. */
const looksZipped = (bytes: Uint8Array): boolean => starts(bytes, [0x50, 0x4b, 0x03, 0x04]) || starts(bytes, [0x50, 0x4b, 0x05, 0x06]) || starts(bytes, [0x50, 0x4b, 0x07, 0x08]);

const overlap = (have: ReadonlySet<string>, known: readonly string[]): number => known.filter((h) => have.has(h)).length;

/**
 * What the bytes are, from the CONTENT alone. A zip is a Foodpanda invoice. Anything else is read as text and its header set must equal the
 * Transactions (68) or the Transfers (10) set of the slice-3 readers, in any order: a count of columns is never a kind, and a set that is
 * neither refuses naming a column it does not know (or the one that is missing) rather than being read as the nearest kind.
 */
export async function detectSettlementKind(bytes: Buffer): Promise<SettlementFileKind> {
  if (looksZipped(bytes)) return 'foodpanda_invoice';
  const text = decodeGrabText(bytes);
  let first: string[];
  try {
    first = (parseCsv(text)[0]?.cells ?? []).map((c) => c.trim());
  } catch (e) {
    throw csvFailure(e);
  }
  const have = new Set(first);
  const same = (known: readonly string[]): boolean => known.every((h) => have.has(h)) && first.every((h) => known.includes(h));
  if (same(GRAB_TRANSACTION_HEADERS)) return 'grab_transactions';
  if (same(GRAB_TRANSFER_HEADERS)) return 'grab_transfers';
  const nearest: readonly string[] = overlap(have, GRAB_TRANSFER_HEADERS) > overlap(have, GRAB_TRANSACTION_HEADERS) ? GRAB_TRANSFER_HEADERS : GRAB_TRANSACTION_HEADERS;
  const unknown = first.find((h) => !nearest.includes(h));
  if (unknown !== undefined) throw intakeRefusal('GRAB_UNKNOWN_COLUMN', `The column "${shown(unknown)}" is not one this system knows.`);
  const missing = nearest.find((h) => !have.has(h));
  throw intakeRefusal('GRAB_MISSING_COLUMN', `The column "${missing ?? ''}" is missing from the header.`);
}

/** What a file said, whatever its kind: the code that finds its channel and the numbers an upload row records. */
interface Parsed {
  kind: SettlementFileKind;
  platform: 'grab' | 'foodpanda';
  code: string;
  periodFrom: string | null;
  periodTo: string | null;
  invoiceNumber: string | null;
  ordersRead: number;
  loanRowsRead: number;
  otherRowsRead: number;
  transactions?: GrabTransactionsFile;
  transfers?: GrabTransfersFile;
  foodpanda?: Awaited<ReturnType<typeof readFoodpandaInvoice>>;
}

const extent = (dates: string[]): { from: string | null; to: string | null } => {
  const sorted = [...dates].sort();
  return { from: sorted[0] ?? null, to: sorted[sorted.length - 1] ?? null };
};

async function readFile(kind: SettlementFileKind, bytes: Buffer): Promise<Parsed> {
  if (kind === 'foodpanda_invoice') {
    const invoice = await readFoodpandaInvoice((await openSettlementZip(bytes)).workbook);
    const { from, to } = extent(invoice.orders.length > 0 ? invoice.orders.map((o) => o.orderDate) : invoice.charges.flatMap((c) => (c.date ? [c.date] : [])));
    return {
      kind, platform: 'foodpanda', code: invoice.vendorCode, periodFrom: from, periodTo: to, invoiceNumber: invoice.invoiceNumber,
      ordersRead: invoice.orders.length, loanRowsRead: 0, otherRowsRead: invoice.charges.length, foodpanda: invoice,
    };
  }
  if (kind === 'grab_transactions') {
    const file = readGrabTransactions(bytes);
    const count = (k: string): number => file.rows.filter((r) => r.kind === k).length;
    return {
      kind, platform: 'grab', code: file.storeId, periodFrom: file.periodFrom, periodTo: file.periodTo, invoiceNumber: null,
      ordersRead: count('payment'), loanRowsRead: count('loan'), otherRowsRead: count('adjustment') + count('advertisement'), transactions: file,
    };
  }
  const file = readGrabTransfers(bytes);
  const { from, to } = extent(file.rows.map((r) => r.payoutDate.date));
  return { kind, platform: 'grab', code: file.storeId, periodFrom: from, periodTo: to, invoiceNumber: null, ordersRead: 0, loanRowsRead: 0, otherRowsRead: 0, transfers: file };
}

/**
 * Every current upload of the other Grab file kind, newest first, each read back from storage with the same reader. One that cannot be read
 * (its stored object is gone, or the current reader refuses an old file) is left out and a plain sentence names its upload date (never an id):
 * the new upload is never blocked by an old file.
 */
async function counterpartsOf(
  tx: Tx,
  orgId: string,
  channelId: string,
  kind: 'grab_transactions' | 'grab_transfers',
  warnings: string[],
): Promise<{ upload: SettlementUploadRow; parsed: Parsed }[]> {
  const found: { upload: SettlementUploadRow; parsed: Parsed }[] = [];
  for (const upload of await settlementIntakeRepo.findCurrentUploads(tx, orgId, channelId, kind)) {
    const skipped = (): void => {
      warnings.push(
        `The ${kind === 'grab_transfers' ? 'Transfers' : 'Transactions'} file uploaded on ${upload.uploadedOn} could not be read back, so it was left out. Upload it again to match it with this file.`,
      );
    };
    const file = await filesRepo.getById(tx, orgId, upload.fileId);
    if (!file) {
      skipped();
      continue;
    }
    try {
      found.push({ upload, parsed: await readFile(kind, Buffer.from(await resolveStorageDriver().get(file.storagePath))) });
    } catch {
      skipped();
    }
  }
  return found;
}

const keyOf = (settlementId: string): string => settlementId.toUpperCase();

/** Transfers files, newest first, merged by settlement id: a payout in two files takes the newer file's row. `owner` maps each id to the index of its file. */
function mergeTransfers(files: GrabTransfersFile[]): { file: GrabTransfersFile; owner: Map<string, number> } {
  const owner = new Map<string, number>();
  const rows = new Map<string, GrabTransferRow>();
  files.forEach((f, i) => {
    for (const r of f.rows) {
      const k = keyOf(r.settlementId);
      if (!rows.has(k)) {
        rows.set(k, r);
        owner.set(k, i);
      }
    }
  });
  return { file: { ...files[0]!, rows: [...rows.values()], rowCount: rows.size }, owner };
}

/** Transactions files, newest first, merged by settlement id: a payout's rows all come from the newest file that has that id. */
function mergeTransactions(files: GrabTransactionsFile[]): { file: GrabTransactionsFile; owner: Map<string, number> } {
  const owner = new Map<string, number>();
  files.forEach((f, i) => {
    for (const r of f.rows) if (r.settlementId !== null && !owner.has(keyOf(r.settlementId))) owner.set(keyOf(r.settlementId), i);
  });
  const rows = files.flatMap((f, i) => f.rows.filter((r) => r.settlementId !== null && owner.get(keyOf(r.settlementId)) === i));
  const from = files.map((f) => f.periodFrom).sort()[0] as string;
  const to = files.map((f) => f.periodTo).sort().reverse()[0] as string;
  return { file: { ...files[0]!, periodFrom: from, periodTo: to, rowCount: rows.length, rows }, owner };
}

const SAME_FIGURES = ['orderValue', 'grossInfo', 'commission', 'marketing', 'platformFee', 'vendorDiscount', 'loanDeduction', 'loanDisbursal', 'netPayout', 'unexplained', 'payoutReference', 'payoutDate', 'paymentArrivalDate', 'paidState', 'feeMonthNote'] as const;
const sameFigures = (line: SettlementDayLineRow, d: StagedDay): boolean => SAME_FIGURES.every((f) => line[f] === d[f]);

const days = (n: number): string => `${n} day${n === 1 ? '' : 's'}`;

export async function ingestSettlementFile(tx: Tx, actor: Actor, input: IngestInput): Promise<IngestResult> {
  const orgId = actor.orgId;
  // (1) coarse gate: before a byte is read, the actor must hold the capability at all. The fine gate (the matched store) comes below.
  if (!(await heldCapabilities(tx, actor)).has('upload_settlement_files')) {
    throw new AuthorizationError(
      "ingestSettlementFile: 'upload_settlement_files' is not held",
      'upload_settlement_files',
      'You do not have permission to upload settlement files. Ask an admin.',
    );
  }

  // (2) size, type and magic bytes: nothing is stored or parsed before they pass.
  const bytes = asBuffer(input.bytes);
  const limits = PURPOSE_LIMITS.channel_settlement_file;
  if (bytes.length === 0) throw intakeRefusal('FILE_EMPTY', 'The file is empty, so there is nothing to read.');
  if (bytes.length > limits.maxBytes) throw intakeRefusal('FILE_TOO_BIG', `The file is ${megabytes(bytes.length)} MB, over the ${megabytes(limits.maxBytes)} MB limit.`);
  if (!limits.types.includes(input.contentType) || !fileBytesMatchType(input.contentType, bytes)) {
    throw intakeRefusal('FILE_TYPE_NOT_ALLOWED', 'Upload the Grab CSV export or the Foodpanda invoice zip as it was downloaded. This file is neither.');
  }

  // (3) the fingerprint is worked out now and looked up only after the store gate.
  const fingerprint = fingerprintOf(bytes);

  // (4) the kind comes from the content; (5) read the file and match its channel by the code it carries.
  const kind = await detectSettlementKind(bytes);
  const parsed = await readFile(kind, bytes);
  const matched = await matchChannel(tx, orgId, parsed.platform, parsed.code);

  // (6) fine gate: the actor must be able to upload for the MATCHED store; the sentence never names it.
  try {
    await authorize(tx, actor, 'upload_settlement_files', { storeId: matched.storeId });
  } catch (e) {
    if (e instanceof AuthorizationError) throw intakeRefusal('NOT_YOUR_STORE', 'This file does not belong to your stores.');
    throw e;
  }
  // audit fix 4: only now, for someone who may see this store, is an inactive channel named
  refuseIfInactive(matched);
  await advisoryLocksRepo.lockSettlementChannel(tx, matched.channelId);

  // (7) a repeat of the same bytes writes nothing.
  const earlier = await settlementIntakeRepo.findUploadByFingerprint(tx, orgId, fingerprint);
  if (earlier) return repeatOf(kind, matched, earlier);

  // (8) stage: Foodpanda from the invoice alone; Grab from the pair, once both files are in.
  const warnings: string[] = [];
  let staged: StagedFile = { days: [], periodLines: [], waitingForRows: [], warnings: [] };
  let waitingFor: IngestResult['waitingFor'] = null;
  // which upload each Grab payout came from: index into the ids of its side (null is THIS upload, whose id is not known yet)
  const sideIds: { transfers: (string | null)[]; transactions: (string | null)[] } = { transfers: [], transactions: [] };
  let owners: { transfers: Map<string, number>; transactions: Map<string, number> } = { transfers: new Map(), transactions: new Map() };
  if (parsed.foodpanda) {
    staged = stageFoodpandaDays(parsed.foodpanda, matched);
  } else {
    const other = kind === 'grab_transactions' ? 'grab_transfers' : 'grab_transactions';
    const found = await counterpartsOf(tx, orgId, matched.channelId, other, warnings);
    const transactionsFiles = parsed.transactions ? [parsed.transactions] : found.flatMap((c) => (c.parsed.transactions ? [c.parsed.transactions] : []));
    const transfersFiles = parsed.transfers ? [parsed.transfers] : found.flatMap((c) => (c.parsed.transfers ? [c.parsed.transfers] : []));
    sideIds.transactions = parsed.transactions ? [null] : found.map((c) => c.upload.id);
    sideIds.transfers = parsed.transfers ? [null] : found.map((c) => c.upload.id);
    if (transactionsFiles.length > 0 && transfersFiles.length > 0) {
      const transactions = mergeTransactions(transactionsFiles);
      const transfers = mergeTransfers(transfersFiles);
      owners = { transfers: transfers.owner, transactions: transactions.owner };
      staged = stageGrabDays(tieGrabPayouts(transactions.file, transfers.file), transactions.file);
    } else if (transfersFiles.length > 0) {
      waitingFor = 'transactions_file';
      staged.waitingForRows = transfersFiles[0]!.rows.map((t) => ({ settlementId: t.settlementId, salesDate: t.payoutDate.date }));
      warnings.push('The Transfers file is saved. It is waiting for the Transactions file before any day can be staged.');
    } else {
      waitingFor = 'transfers_file';
      warnings.push('The Transactions file is saved. It is waiting for the Transfers file before any day can be staged.');
    }
  }
  warnings.push(...staged.warnings);
  for (const d of staged.days) checkStagedDay(d);
  checkStagedPeriodLines(staged.periodLines);

  // (9) store the original under the MATCHED store (an admin may hold no store; the evidence belongs to the store it is about).
  const stored = await uploadFile(tx, actor, { purpose: 'channel_settlement_file', storeId: matched.storeId, contentType: input.contentType, bytes });
  const { row: upload, created } = await settlementIntakeRepo.insertUpload(tx, orgId, {
    channelId: matched.channelId,
    storeId: matched.storeId,
    platform: parsed.platform,
    fileKind: kind,
    fileId: stored.fileId,
    pdfFileId: null, // the zip, which holds the PDF, is stored whole; the PDF is never parsed
    fingerprint,
    readerVersion: READER_VERSION,
    matchedCode: matched.code,
    periodFrom: parsed.periodFrom,
    periodTo: parsed.periodTo,
    invoiceNumber: parsed.invoiceNumber,
    ordersRead: parsed.ordersRead,
    loanRowsRead: parsed.loanRowsRead,
    otherRowsRead: parsed.otherRowsRead,
    uploadedBy: actor.personId,
  });
  // not reachable behind the channel lock; if it ever is, the answer is still "already uploaded" (the extra stored file is an orphan the sweep collects)
  if (!created) return repeatOf(kind, matched, upload);

  // (10) the same channel, kind and period replace the earlier upload; a file with fewer days than the one it replaces says so.
  if (parsed.periodFrom !== null && parsed.periodTo !== null) {
    const replaced = (await settlementIntakeRepo.findCurrentUploads(tx, orgId, matched.channelId, kind)).filter(
      (u) => u.id !== upload.id && u.periodFrom === parsed.periodFrom && u.periodTo === parsed.periodTo,
    );
    if (replaced.length > 0 && waitingFor === null) {
      const before = await settlementIntakeRepo.countCurrentDaysInPeriod(tx, orgId, matched.channelId, parsed.periodFrom, parsed.periodTo);
      if (staged.days.length < before) warnings.push(`This file covers fewer days (${staged.days.length}) than the file it replaces (${before}). Days it does not have keep their earlier figures.`);
    }
    for (const u of replaced) await settlementIntakeRepo.markSuperseded(tx, orgId, u.id, upload.id);
  }

  // (11) each day: unchanged -> nothing; changed -> a new version, the old one retired (a booked one is never touched, its replacement is flagged).
  // Grab: a day's source is the Transactions upload that holds its rows, its payout upload the Transfers upload that holds its payout; Foodpanda: this invoice
  const uploadOf = (ids: (string | null)[], owner: Map<string, number>, key: string | null): string | null => {
    const i = key === null ? undefined : owner.get(key);
    return i === undefined ? null : (ids[i] ?? upload.id);
  };
  let daysStaged = 0;
  let daysUnchanged = 0;
  let waitingForSalesDay = 0;
  let unbalanced = 0;
  for (const d of staged.days) {
    const current = await settlementIntakeRepo.currentLine(tx, orgId, matched.channelId, d.salesDate);
    if (current && sameFigures(current, d)) {
      daysUnchanged += 1;
      continue;
    }
    if (current) await settlementIntakeRepo.retireCurrentLine(tx, orgId, current.id);
    // the snapshot of what staff recorded; an unverified or missing sales day has none, and the file never verifies a day
    const figure = await settlementIntakeRepo.salesDayFigure(tx, orgId, matched.channelId, d.salesDate);
    const recorded: Money | null = figure.recorded ?? (figure.verified && figure.noSales ? ZERO : null);
    if (recorded === null) waitingForSalesDay += 1;
    if (d.warnings.length > 0) unbalanced += 1;
    const key = d.platform === 'grab' && d.payoutReference !== null ? keyOf(d.payoutReference) : null;
    const line = await settlementIntakeRepo.insertDayLineVersion(tx, orgId, {
      channelId: matched.channelId,
      storeId: matched.storeId,
      platform: d.platform,
      salesDate: d.salesDate,
      version: current ? current.version + 1 : 1,
      sourceUploadId: uploadOf(sideIds.transactions, owners.transactions, key) ?? upload.id,
      payoutUploadId: uploadOf(sideIds.transfers, owners.transfers, key),
      orderValue: d.orderValue,
      grossInfo: d.grossInfo,
      commission: d.commission,
      marketing: d.marketing,
      platformFee: d.platformFee,
      vendorDiscount: d.vendorDiscount,
      loanDeduction: d.loanDeduction,
      loanDisbursal: d.loanDisbursal,
      netPayout: d.netPayout,
      unexplained: d.unexplained,
      recordedFigure: recorded,
      difference: recorded === null ? null : subtract(d.orderValue, recorded),
      payoutReference: d.payoutReference,
      payoutDate: d.payoutDate,
      paymentArrivalDate: d.paymentArrivalDate,
      paidState: d.paidState,
      feeMonthNote: d.feeMonthNote,
      // once flagged it stays flagged through later versions (v1 booked, v2 changed, v3 changed again)
      changedSinceBooked: current ? current.changedSinceBooked || current.reviewState === 'booked' : false,
    });
    await settlementIntakeRepo.insertLoanLines(tx, orgId, line.id, d.loanLines);
    await settlementIntakeRepo.insertOtherLines(tx, orgId, upload.id, line.id, d.otherLines);
    daysStaged += 1;
  }
  await settlementIntakeRepo.insertOtherLines(tx, orgId, upload.id, null, staged.periodLines);
  if (waitingForSalesDay > 0) warnings.push(`${days(waitingForSalesDay)} staged but waiting for the sales day to be verified before the figure staff recorded can be compared.`);
  if (unbalanced > 0) warnings.push(`${days(unbalanced)} do not add up to the payout: see the unexplained amount on each.`);

  // (12) the audit entry, in the same transaction.
  await auditLogRepo.append(tx, orgId, {
    actorPersonId: actor.personId,
    action: 'settlement_upload.ingested',
    storeId: matched.storeId,
    entityId: upload.id,
    before: null,
    after: { kind, platform: parsed.platform, periodFrom: parsed.periodFrom, periodTo: parsed.periodTo, daysStaged, daysUnchanged, waitingForRows: staged.waitingForRows.length },
    source: 'web',
  });

  return {
    kind, platform: parsed.platform, channelId: matched.channelId, storeId: matched.storeId, storeName: matched.storeName, uploadId: upload.id,
    alreadyUploaded: false, uploadedOn: null, daysStaged, daysUnchanged, waitingForRows: staged.waitingForRows.length, waitingFor, warnings,
  };
}

function repeatOf(kind: SettlementFileKind, matched: MatchedChannel, earlier: SettlementUploadRow): IngestResult {
  return {
    kind, platform: matched.platform, channelId: matched.channelId, storeId: matched.storeId, storeName: matched.storeName, uploadId: earlier.id,
    alreadyUploaded: true, uploadedOn: earlier.uploadedOn, daysStaged: 0, daysUnchanged: 0, waitingForRows: 0, waitingFor: null, warnings: [],
  };
}
