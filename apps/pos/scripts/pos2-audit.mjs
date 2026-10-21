#!/usr/bin/env node
// T-424 Ruling 11 - the POS v2 detector. READ-ONLY, run by a person (never by a build or a request).
//
//   node apps/pos/scripts/pos2-audit.mjs --from=20261001 --to=20261016 [--store=<pos store id>]...
//   POS_FIREBASE_SA_KEY_FILE=<path to the service-account JSON> is read from the environment (never printed, never a flag).
//
// For each store and day (Manila business day of the document's own clock) it lists, as COUNTS and RECEIPT / DOCUMENT NUMBERS ONLY:
//   1. refund receipts with no `approvedByPersonId`                (a refund the POS v2 server did not approve: v1's open doors, or a forged record)
//   2. refund receipts with no `receiptNumbers/{number}` document  (a refund that skipped the numbered series)
//   3. `paymentConversions` whose source is neither 'pos2-correction' nor 'pos2-convert' (made outside POS v2)
//   4. 'pos2-correction' conversions that v1 has since VOIDED      (status 'voided': v1's dashboard reversed a v2 correction)
//   5. unpaid sessions VOIDED OFFLINE (T-425, `voidedOffline: true`)   (a manager reviews every void made without the internet; listed by session id)
//   6. 'pos2-convert' documents voided without voidedVia 'pos2'
//   7. final day totals with negative payment methods (counts and related conversion ids, never amounts)
// It only ever calls `.get()`: no write, no update, no delete. Exit code 0 when everything is clean, 2 when anything is listed, 1 on error.
import { readFileSync } from 'node:fs';
import { auditDayOf as dayOf, auditRange, classifyConversion, negativeDays } from './pos2-audit-lib.mjs';

const args = process.argv.slice(2);
const flag = (name) => args.filter((a) => a.startsWith(`--${name}=`)).map((a) => a.slice(name.length + 3));
const [from] = flag('from');
const [to] = flag('to');
const onlyStores = flag('store');
const keyFile = (process.env.POS_FIREBASE_SA_KEY_FILE ?? '').trim();
const range = auditRange(from, to);
const logbook = args.includes('--statutory-logbook');
const fixtureFile = logbook ? process.env.POS2_AUDIT_FIXTURE : null;

if ((!keyFile && !fixtureFile) || !range) {
  console.error('Usage: POS_FIREBASE_SA_KEY_FILE=<service-account.json> node apps/pos/scripts/pos2-audit.mjs --from=YYYYMMDD --to=YYYYMMDD [--store=<pos store id>]...');
  process.exit(1);
}

const { fromMs, toMs } = range;

async function openDatabase() {
  const [{ cert, initializeApp }, { FieldPath, getFirestore }] = await Promise.all([
    import('firebase-admin/app'), import('firebase-admin/firestore'),
  ]);
  const credential = JSON.parse(readFileSync(keyFile, 'utf8'));
  const app = initializeApp({ credential: cert(credential), projectId: credential.project_id }, 'pos2-audit');
  return { db: getFirestore(app), FieldPath };
}

// Explicit management export only; the default detector still prints no identities or amounts.
if (logbook) {
  const { statutoryLogbookRows, renderStatutoryLogbook } = await import('./lib/statutory-logbook.mjs');
  const rows = [];
  if (fixtureFile) {
    const fixture = JSON.parse(readFileSync(fixtureFile, 'utf8'));
    const stores = onlyStores.length ? onlyStores : Object.keys(fixture.stores ?? {}).sort();
    for (const storeId of stores) rows.push(...statutoryLogbookRows(storeId, fixture.stores?.[storeId]?.receipts ?? [], range));
  } else {
    const { db } = await openDatabase();
    const stores = onlyStores.length ? onlyStores : (await db.collection('stores').select().get()).docs.map(doc => doc.id).sort();
    for (const storeId of stores) {
      const collection = db.collection(`stores/${storeId}/receipts`);
      const [sales, refunds] = await Promise.all([
        collection.where('createdAtClientMs', '>=', fromMs).where('createdAtClientMs', '<=', toMs).get(),
        collection.where('isRefund', '==', true).get(),
      ]);
      rows.push(...statutoryLogbookRows(storeId, [...sales.docs, ...refunds.docs].map(doc => ({ id: doc.id, data: doc.data() })), range));
    }
  }
  process.stdout.write(renderStatutoryLogbook(rows, { from, to }));
  process.exit(0);
}

const { db, FieldPath } = await openDatabase();

const storeIds = onlyStores.length ? onlyStores : (await db.collection('stores').select().get()).docs.map((d) => d.id);
let listed = 0;

for (const storeId of storeIds) {
  const days = new Map(); // dayId -> { unapprovedRefunds, unnumberedRefunds, foreignConversions, voidedCorrections, voidedOffline }
  const bucket = (dayId) => {
    if (!days.has(dayId)) days.set(dayId, { unapprovedRefunds: [], unnumberedRefunds: [], foreignConversions: [], voidedCorrections: [], voidedByV1: [], voidedOffline: [] });
    return days.get(dayId);
  };

  const refunds = await db.collection(`stores/${storeId}/receipts`).where('isRefund', '==', true).get();
  for (const d of refunds.docs) {
    const r = d.data();
    const ms = Number(r.createdAtClientMs);
    if (!Number.isFinite(ms) || ms < fromMs || ms > toMs) continue;
    const label = String(r.receiptNumber ?? d.id);
    if (!r.approvedByPersonId) bucket(dayOf(ms)).unapprovedRefunds.push(label);
    const numberSnap = r.receiptNumber ? await db.doc(`stores/${storeId}/receiptNumbers/${r.receiptNumber}`).get() : null;
    if (!numberSnap || !numberSnap.exists) bucket(dayOf(ms)).unnumberedRefunds.push(label);
  }

  const conversions = await db.collection(`stores/${storeId}/paymentConversions`).get();
  const conversionDays = [];
  for (const d of conversions.docs) {
    const c = d.data();
    const ms = Number(c.createdAtClientMs);
    const dayId = c.dayId != null ? String(c.dayId) : Number.isFinite(ms) ? dayOf(ms) : null;
    if (dayId === null) continue;
    // A correction may have been entered later for an older receipt day. Keep it with that day's negative-total evidence.
    conversionDays.push({ id: d.id, dayId });
    if (!Number.isFinite(ms) || ms < fromMs || ms > toMs) continue;
    for (const tag of classifyConversion(c)) {
      if (tag === 'foreign') bucket(dayId).foreignConversions.push(d.id);
      else if (tag === 'voidedCorrection') bucket(dayId).voidedCorrections.push(d.id);
      else if (tag === 'voidedByV1') bucket(dayId).voidedByV1.push(d.id);
    }
  }

  const analytics = await db.collection(`stores/${storeId}/analytics`)
    .where(FieldPath.documentId(), '>=', from).where(FieldPath.documentId(), '<=', to).get();
  const finalDays = analytics.docs.map((d) => ({ dayId: d.id, byMethod: d.data().payments?.byMethod ?? {} }));
  for (const day of negativeDays(finalDays, conversionDays)) {
    listed += day.methods.length;
    console.log(`store ${storeId}  day ${day.dayId}`);
    console.log(`  final payment methods below zero (${day.methods.length})`);
    console.log(`  conversions and corrections (${day.conversionIds.length}): ${day.conversionIds.join(', ') || 'none'}`);
  }

  // T-425: sessions voided without the internet. `voidedAt` is a Firestore timestamp (the void's own server time, set when the write landed).
  const offlineVoids = await db.collection(`stores/${storeId}/sessions`).where('voidedOffline', '==', true).get();
  for (const d of offlineVoids.docs) {
    const v = d.data();
    const ms = typeof v.voidedAt?.toMillis === 'function' ? v.voidedAt.toMillis() : typeof v.updatedAt?.toMillis === 'function' ? v.updatedAt.toMillis() : Number.NaN;
    if (!Number.isFinite(ms) || ms < fromMs || ms > toMs) continue;
    bucket(dayOf(ms)).voidedOffline.push(d.id);
  }

  for (const [dayId, b] of [...days.entries()].sort()) {
    const n = b.unapprovedRefunds.length + b.unnumberedRefunds.length + b.foreignConversions.length + b.voidedCorrections.length + b.voidedByV1.length + b.voidedOffline.length;
    if (n === 0) continue;
    listed += n;
    console.log(`store ${storeId}  day ${dayId}`);
    if (b.unapprovedRefunds.length) console.log(`  refunds without an approver (${b.unapprovedRefunds.length}): ${b.unapprovedRefunds.join(', ')}`);
    if (b.unnumberedRefunds.length) console.log(`  refunds without a receipt-number record (${b.unnumberedRefunds.length}): ${b.unnumberedRefunds.join(', ')}`);
    if (b.foreignConversions.length) console.log(`  payment conversions not made by POS v2 (${b.foreignConversions.length}): ${b.foreignConversions.join(', ')}`);
    if (b.voidedCorrections.length) console.log(`  POS v2 corrections voided by v1 (${b.voidedCorrections.length}): ${b.voidedCorrections.join(', ')}`);
    if (b.voidedByV1.length) console.log(`  POS v2 conversions voided outside POS v2 (${b.voidedByV1.length}): ${b.voidedByV1.join(', ')}`);
    if (b.voidedOffline.length) console.log(`  sessions voided offline, for a manager to review (${b.voidedOffline.length}): ${b.voidedOffline.join(', ')}`);
  }
}

console.log(listed === 0 ? `pos2-audit: nothing to report for ${from} to ${to}.` : `pos2-audit: ${listed} item(s) listed for ${from} to ${to}.`);
process.exit(listed === 0 ? 0 : 2);
