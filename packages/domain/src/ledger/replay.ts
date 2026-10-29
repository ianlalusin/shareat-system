/**
 * T-488 (DEF-777) — the request id a retryable posting carries, and the one comparison that tells a genuine
 * double-submit from a different transaction reusing the same id. Bible §4.2 rule 10: a retryable operation
 * "carries a client-supplied key"; the form mints it once per render (`crypto.randomUUID()` in a hidden
 * `requestId` input, as `money-transfers/page.tsx` does) and the domain keys the entry on it.
 *
 * Before this, nine paths built the key from business attributes (`owner:<id>:drawing:<date>:<amount>`), so a
 * genuine second identical transaction on the same day matched the first, `postEntry` answered `created: false`,
 * and the caller reported success for a posting that never happened.
 */
import { journalRepo, type Tx } from '@shareat/db';
import { postEntry, lineAmount, type PostEntryInput, type PostEntryResult } from './post-entry';
import { refuse } from '../shared/refusal';

export const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The form's request id, or a refusal: a missing or non-uuid value means a stale or hand-built form. */
export function requireRequestId(fn: string, requestId: string | null | undefined): string {
  if (typeof requestId !== 'string' || !UUID_SHAPE.test(requestId)) {
    throw refuse(
      `${fn}: requestId is missing or not a uuid`,
      'This form is out of date. Reload the page and try again.',
    );
  }
  return requestId;
}

/**
 * `postEntry`, plus the replay check. A fresh key posts as usual. A key that already exists is a double-submit only
 * if the entry it names carries the lines now being asked for (account, store, party, debit, credit); otherwise the
 * caller reused an id for a different transaction and is refused rather than handed the old entry as if it were
 * theirs. `postEntry` itself is unchanged.
 */
export async function postEntryOnce(tx: Tx, input: PostEntryInput): Promise<PostEntryResult> {
  const result = await postEntry(tx, input);
  if (result.created) return result;

  // DEF-787 (T-488 S2): `postEntry` answers a known key before it reads `entryDate`, and a request-id key no longer
  // carries the date, so a re-sent form with a changed date would be handed the old entry. Compare the dates only;
  // never re-resolve the period, so an unchanged retry still succeeds after the original month has closed.
  const header = await journalRepo.findEntryByIdempotencyKey(tx, input.orgId, input.idempotencyKey);
  if (header && String(header.entryDate).slice(0, 10) !== String(input.entryDate).slice(0, 10)) {
    throw refuse(
      `postEntryOnce: idempotency key '${input.idempotencyKey}' was already posted on ${header.entryDate}, not ${input.entryDate}`,
      'This was already recorded with different figures. Reload the page and try again.',
    );
  }

  const existing = await journalRepo.findLinesForEntryWithAccountCodes(tx, result.entryId);
  // Compared as sorted sets of normalised lines, not by position: the answer must not depend on how the repo orders rows.
  // Both sides' figures go through the same minting, so '2000' and '2000.00' read alike.
  const key = (
    accountCode: string,
    storeId: string | null | undefined,
    partyType: string | null | undefined,
    partyId: string | null | undefined,
    debit: string,
    credit: string,
  ) => JSON.stringify([accountCode, storeId ?? null, partyType ?? null, partyId ?? null, debit, credit]);
  const wanted = input.lines
    .map((line, index) =>
      key(
        line.accountCode,
        line.storeId,
        line.partyType,
        line.partyId,
        String(lineAmount(line.debit, 'debit', index, line.accountCode)),
        String(lineAmount(line.credit, 'credit', index, line.accountCode)),
      ),
    )
    .sort();
  const have = existing
    .map((line, index) =>
      key(
        line.accountCode,
        line.storeId,
        line.partyType,
        line.partyId,
        String(lineAmount(line.debit, 'debit', index, line.accountCode)),
        String(lineAmount(line.credit, 'credit', index, line.accountCode)),
      ),
    )
    .sort();
  const same = have.length === wanted.length && have.every((k, i) => k === wanted[i]);
  if (!same) {
    throw refuse(
      `postEntryOnce: idempotency key '${input.idempotencyKey}' was already posted with different lines`,
      'This was already recorded with different figures. Reload the page and try again.',
    );
  }
  return result;
}
