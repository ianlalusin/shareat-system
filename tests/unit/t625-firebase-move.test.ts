import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  chunk,
  decideCopy,
  fileGap,
  filterAuthExport,
  parseAuthExport,
  parseMode,
  parseUidList,
  runCopy,
  summariseVerify,
  type CopyPorts,
  type FileItem,
  type ObjMeta,
} from '../../scripts/firebase-move/lib';

/**
 * T-625 S2 - the pure rules of the Firebase move, with fakes (no Google, no database).
 * Mutants (each proven red, see the task report): uid filter inverted / off-by-one; copy skip on size only, or on missing md5;
 * runCopy copying in a dry run; runCopy not re-checking what landed; verify passing on zero accounts; a delete added to the scripts.
 */
const m = (md5: string, size = 10): ObjMeta => ({ md5, size });
const file = (id: string, purpose = 'receipt_photo'): FileItem => ({ id, path: `orgs/o/${id}`, purpose, byteSize: 10 });

describe('uid filter', () => {
  const exp = { users: [{ localId: 'a', email: 'x' }, { localId: 'b' }, { localId: 'c' }, { localId: 'd' }] };

  it('keeps exactly the listed uids and never drops a listed one', () => {
    const r = filterAuthExport(exp, ['a', 'c', 'd']);
    expect(r.filtered.users.map((u) => u.localId)).toEqual(['a', 'c', 'd']);
    expect(r).toMatchObject({ kept: 3, missing: 0, extraDropped: 1 });
  });

  it('keeps the first and the last user (off-by-one at both ends)', () => {
    expect(filterAuthExport(exp, ['a', 'd']).filtered.users.map((u) => u.localId)).toEqual(['a', 'd']);
  });

  it('counts a listed uid that the export does not hold as missing, not as kept', () => {
    expect(filterAuthExport(exp, ['a', 'zzz'])).toMatchObject({ kept: 1, missing: 1 });
  });

  it('an empty uid list keeps nobody (never "everybody")', () => {
    expect(filterAuthExport(exp, []).kept).toBe(0);
  });

  it('keeps the other fields of a kept user (password hash and salt travel with it)', () => {
    const r = filterAuthExport({ users: [{ localId: 'a', passwordHash: 'h', salt: 's' }] }, ['a']);
    expect(r.filtered.users[0]).toEqual({ localId: 'a', passwordHash: 'h', salt: 's' });
  });

  it('parses the uid file: trims, ignores blanks and # comments, collapses duplicates, refuses a line with a space', () => {
    expect(parseUidList('a\r\n\n # note\n b \na\n')).toEqual(['a', 'b']);
    expect(() => parseUidList('hello world')).toThrow(/space/);
  });

  it('refuses an export without a users list or without localIds', () => {
    expect(() => parseAuthExport('nope')).toThrow(/JSON/);
    expect(() => parseAuthExport('{"users":[{"email":"x"}]}')).toThrow(/localId/);
    expect(parseAuthExport('{"users":[{"localId":"a"}]}').users).toHaveLength(1);
  });
});

describe('copy decision (MD5 skip logic)', () => {
  it('copies when the new bucket has no such object', () => expect(decideCopy(m('x'), null)).toBe('copy'));
  it('copies when the MD5 differs', () => expect(decideCopy(m('x'), m('y'))).toBe('copy'));
  it('copies when the size differs even if the MD5 matches', () => expect(decideCopy(m('x', 10), m('x', 11))).toBe('copy'));
  it('skips when MD5 and size are equal', () => expect(decideCopy(m('x'), m('x'))).toBe('skip'));
  it('never skips on an unknown (empty) MD5, even when both are empty', () => expect(decideCopy(m(''), m(''))).toBe('copy'));
  it('reports a missing source before anything else', () => {
    expect(decideCopy(null, null)).toBe('missing-source');
    expect(decideCopy(null, m('x'))).toBe('missing-source');
  });
});

/** A fake pair of buckets. It records every call, and has no delete to call. */
function fakes(src: Record<string, ObjMeta>, dst: Record<string, ObjMeta>, opts: { corrupt?: string[]; throwOn?: string[] } = {}) {
  const calls: string[] = [];
  const ports: CopyPorts = {
    statSrc: async (p) => src[p] ?? null,
    statDst: async (p) => dst[p] ?? null,
    copyObject: async (p) => {
      calls.push(p);
      if (opts.throwOn?.includes(p)) throw new Error('secret-looking text that must not be echoed');
      dst[p] = opts.corrupt?.includes(p) ? m('WRONG', 10) : { ...src[p]! };
    },
  };
  return { ports, calls, dst };
}

describe('runCopy', () => {
  const files = [file('1'), file('2'), file('3'), file('4', 'staff_photo')];
  const src = { 'orgs/o/1': m('a'), 'orgs/o/2': m('b'), 'orgs/o/3': m('c') }; // 4 is missing in the old bucket

  it('copies missing and changed objects, skips equal ones, reports a missing source, and lists only non-guarded problem ids', async () => {
    const f = fakes(src, { 'orgs/o/1': m('a'), 'orgs/o/2': m('OLD') });
    const r = await runCopy(files, f.ports, true);
    expect(r).toMatchObject({ total: 4, copied: 2, skipped: 1, missingSource: 1, failed: 0, wouldCopy: 0 });
    expect(f.calls).toEqual(['orgs/o/2', 'orgs/o/3']);
    expect(r.problemIds).toEqual([]); // the one problem file is a staff_photo: counted, never listed
  });

  it('lists the id of a missing non-guarded file', async () => {
    const r = await runCopy([file('9')], fakes({}, {}).ports, true);
    expect(r).toMatchObject({ missingSource: 1, problemIds: ['9'] });
  });

  it('a dry run copies nothing and says what it would copy', async () => {
    const f = fakes(src, {});
    const r = await runCopy(files, f.ports, false);
    expect(f.calls).toEqual([]);
    expect(r).toMatchObject({ wouldCopy: 3, copied: 0, missingSource: 1 });
  });

  it('is safe to run twice: the second run copies nothing', async () => {
    const f = fakes(src, {});
    await runCopy(files, f.ports, true);
    const again = await runCopy(files, f.ports, true);
    expect(again).toMatchObject({ copied: 0, skipped: 3 });
  });

  it('counts a copy whose result does not match the source as failed, not copied', async () => {
    const f = fakes(src, {}, { corrupt: ['orgs/o/1'] });
    const r = await runCopy(files, f.ports, true);
    expect(r).toMatchObject({ copied: 2, failed: 1, problemIds: ['1'] });
  });

  it('counts a thrown copy as failed and carries on with the next file', async () => {
    const f = fakes(src, {}, { throwOn: ['orgs/o/1'] });
    const r = await runCopy(files, f.ports, true);
    expect(r).toMatchObject({ copied: 2, failed: 1 });
    expect(JSON.stringify(r)).not.toContain('secret-looking');
  });
});

describe('verify rules', () => {
  it('a file is fine only when present at the recorded size', () => {
    expect(fileGap(file('1'), m('x', 10))).toBeNull();
    expect(fileGap(file('1'), m('x', 9))).toBe('size');
    expect(fileGap(file('1'), null)).toBe('missing');
  });

  const base = { uidsChecked: 3, uidsMissing: 0, filesChecked: 5, filesMissing: 0, filesWrongSize: 0 };
  it('passes only with no gap', () => expect(summariseVerify(base).ok).toBe(true));
  it('fails on a missing account', () => expect(summariseVerify({ ...base, uidsMissing: 1 }).ok).toBe(false));
  it('fails on a missing file', () => expect(summariseVerify({ ...base, filesMissing: 1 }).ok).toBe(false));
  it('fails on a wrong-size file', () => expect(summariseVerify({ ...base, filesWrongSize: 1 }).ok).toBe(false));
  it('fails when no account was checked at all (an empty read is not a clean bill)', () => {
    expect(summariseVerify({ ...base, uidsChecked: 0 }).ok).toBe(false);
  });
  it('splits uids into batches of at most 100 without losing one', () => {
    const uids = Array.from({ length: 250 }, (_, i) => `u${i}`);
    const parts = chunk(uids, 100);
    expect(parts.map((p) => p.length)).toEqual([100, 100, 50]);
    expect(parts.flat()).toEqual(uids);
  });
});

describe('script safety', () => {
  it('--dry-run is the default; --confirm opts in; both together is refused', () => {
    expect(parseMode([]).confirm).toBe(false);
    expect(parseMode(['--dry-run']).confirm).toBe(false);
    expect(parseMode(['--confirm']).confirm).toBe(true);
    expect(() => parseMode(['--confirm', '--dry-run'])).toThrow(/not both/);
  });

  it('no script in scripts/firebase-move can delete: no delete/remove call, no write to Postgres', () => {
    const dir = path.resolve(__dirname, '..', '..', 'scripts', 'firebase-move');
    const names = readdirSync(dir).filter((f) => f.endsWith('.ts'));
    expect(names.length).toBeGreaterThanOrEqual(6); // positive control: the scan saw the scripts
    for (const n of names) {
      const code = readFileSync(path.join(dir, n), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .map((l) => l.replace(/\/\/.*$/, ''))
        .join('\n');
      expect(code, `${n} must not delete anything`).not.toMatch(/\.delete\(|\.deleteFiles\(|\.deleteUser|deleteUsers\(|\.remove\(|\bunlink|\brmSync|\bDELETE\b|\.insert\(|\.update\(/);
    }
  });
});
