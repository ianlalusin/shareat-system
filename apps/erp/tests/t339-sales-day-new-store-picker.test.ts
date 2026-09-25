/**
 * T-339 slice 4 (DEF-148) — `/sales-days/new` can submit another store's channel ids.
 *
 * The page is a server component with no client code; the `<select name="storeId">` used to sit
 * inside the POST form while the channel rows it submits alongside come from `?store=` in the URL
 * — an attacker (or a stale tab) can pick store A's `storeId` in the select while the rendered
 * channel rows and their hidden `channel_<id>` names are still store B's, from a different
 * `?store=` visit that never re-fetched. Source-structure test in the idiom of
 * `apps/erp/tests/service-charge-wiring.test.ts` — `page.tsx` is a server component, awkward to
 * exercise directly, so this reads the real source text.
 *
 * Fix under test (docs/tasks/339-small-defects-batch-1.md slice 4): the store choice moves into a
 * `FilterRow` GET form (`name="store"`) above the POST form; the POST form gets a read-only
 * `<input type="hidden" name="storeId">` instead of a `<select name="storeId">`.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const pagePath = resolve(here, '..', 'src', 'app', 'sales-days', 'new', 'page.tsx');
const source = readFileSync(pagePath, 'utf8');

/** The POST form: from `<form action={createSalesDayAction}` to its matching `</form>`. */
function postFormSlice(src: string): string {
  const start = src.indexOf('<form action={createSalesDayAction}');
  if (start === -1) throw new Error('createSalesDayAction form not found — page structure changed.');
  const end = src.indexOf('</form>', start);
  if (end === -1) throw new Error('no closing </form> found after the createSalesDayAction form.');
  return src.slice(start, end + '</form>'.length);
}

describe('/sales-days/new does not let the POST form submit another store\'s ids (DEF-148)', () => {
  it('red: no <select name="storeId"> inside the POST form', () => {
    const postForm = postFormSlice(source);
    const hasStoreSelect = /<select[^>]*\bname="storeId"/.test(postForm);
    expect(hasStoreSelect).toBe(false);
  });

  it('negative half: the POST form carries storeId as a read-only hidden input instead', () => {
    const postForm = postFormSlice(source);
    // One tag must carry all three attributes together — attribute order tolerant via
    // lookaheads, so this cannot be satisfied by three attributes scattered across different
    // elements the way three independent toContain()s could be.
    const hiddenStoreIdInput =
      /<input(?=[^>]*\btype="hidden")(?=[^>]*\bname="storeId")(?=[^>]*\bvalue=\{storeId\})[^>]*>/;
    expect(hiddenStoreIdInput.test(postForm)).toBe(true);
  });

  it('negative half: the store switch lives in a FilterRow GET form outside the POST form', () => {
    const postForm = postFormSlice(source);
    const beforePostForm = source.slice(0, source.indexOf(postForm));
    expect(beforePostForm).toContain('<FilterRow');
    expect(/<select[^>]*\bname="store"/.test(beforePostForm)).toBe(true);
  });

  it('negative half: the channel listing and the hidden storeId use the same identifier', () => {
    const listChannelsCall = /listChannels\(\s*orgId\s*,\s*(\w+)\s*\)/.exec(source);
    if (!listChannelsCall) throw new Error('listChannels(orgId, <id>) call not found.');
    const channelsIdentifier = listChannelsCall[1]!;

    const postForm = postFormSlice(source);
    const hiddenValue = /<input[^>]*\bname="storeId"[^>]*\bvalue=\{\s*(\w+)\s*\}/.exec(postForm);
    if (!hiddenValue) throw new Error('hidden storeId input with a value={...} binding not found.');
    const hiddenIdentifier = hiddenValue[1]!;

    expect(hiddenIdentifier).toBe(channelsIdentifier);
  });
});

describe('/sales-days/new does not offer another store\'s wallets either (DEF-148, other half)', () => {
  /**
   * Today `listMoneyAccountsForPicker(orgId)` is called UNFILTERED — every wallet in the org
   * renders on every store's form, regardless of `?store=`. `create.ts:309`
   * (`sales-days-create.ts`'s tender resolver) refuses a tender against a wallet outside the
   * day's own store ("a day may only report money into its own store's wallets"), so today's
   * page can render a wallet row that create-time refuses the moment it is filled in and saved —
   * the same shape of bug slice 4's `storeId` fix addressed for channels.
   *
   * Two acceptable fixes, per the picker's own return shape (`{ id, name, storeId, custodian }`
   * in `apps/erp/src/app/expenses/lib.ts`): the call itself takes storeId as a second argument,
   * or the returned list is `.filter()`ed by `w.storeId === storeId` before render. Either is
   * accepted; a THIRD identifier smuggled in under either form is not (the negative half below).
   */
  function walletsFilterIdentifier(src: string): string {
    const callIdx = src.indexOf('listMoneyAccountsForPicker(');
    if (callIdx === -1) throw new Error('listMoneyAccountsForPicker(...) call not found.');
    // A window past the call site wide enough to catch a chained `.filter(...)` on the same or a
    // following statement, without reaching into unrelated code further down the page.
    const window = src.slice(callIdx, callIdx + 400);

    const directArg = /listMoneyAccountsForPicker\(\s*orgId\s*,\s*(\w+)\s*\)/.exec(window);
    if (directArg) return directArg[1]!;

    const chainedFilter = /\.filter\(\s*\(?\s*\w+\s*\)?\s*=>\s*\w+\.storeId\s*===\s*(\w+)\s*\)/.exec(window);
    if (chainedFilter) return chainedFilter[1]!;

    throw new Error(
      'wallets are not filtered to a store: neither listMoneyAccountsForPicker(orgId, <id>) nor ' +
        'a chained .filter(w => w.storeId === <id>) was found near the call site.',
    );
  }

  it('red: the wallet list the POST form renders is filtered to a store, not org-wide', () => {
    expect(() => walletsFilterIdentifier(source)).not.toThrow();
  });

  it('negative half: the wallet filter uses the SAME identifier as the hidden storeId input', () => {
    const walletsIdentifier = walletsFilterIdentifier(source);

    const postForm = postFormSlice(source);
    const hiddenValue = /<input[^>]*\bname="storeId"[^>]*\bvalue=\{\s*(\w+)\s*\}/.exec(postForm);
    if (!hiddenValue) throw new Error('hidden storeId input with a value={...} binding not found.');
    const hiddenIdentifier = hiddenValue[1]!;

    expect(walletsIdentifier).toBe(hiddenIdentifier);
  });
});
