import { describe, expect, it } from 'vitest';

/**
 * T-441 S1 TESTER - the upload reducer (pure, node). Mutants M1-M4 (+ stale-event safety).
 * docs/tasks/441-photo-upload-control.md section 4 (`upload-state.ts`) and S1.
 *
 * ASSUMED CONTRACT (the spec fixes the states and names; these are the shapes the tests need):
 *   initialState(existing?: { fileId: string; kind: 'image' | 'pdf' }) -> State
 *   reduce(state, action) -> State                       (pure, never mutates its input)
 *   percent(state) -> number | null                      (null = cannot be measured: show "Uploading...")
 *   shouldAbort(state, action) -> boolean                (true when the action makes an in-flight XHR/compression stale)
 *   State is a union discriminated by `status`: 'empty' | 'selected' | 'compressing' | 'uploading' | 'done' | 'failed' | 'existing'
 *     selected/compressing/uploading carry `file`; uploading also `loaded`, `total`; done carries `fileId`, `preview`;
 *     failed carries `reason`, `retryable`, `file` (the compressed file Retry re-sends); existing carries `fileId`, `kind`.
 *   Actions, by `type`: pick{file} compress compressed{file} progress{loaded,total} uploaded{fileId,preview?}
 *     fail{reason,retryable?} retry replace remove unmount
 * RED reason before the build: the module does not exist.
 */
async function load() {
  try {
    return await import('../src/components/upload/upload-state');
  } catch (err) {
    throw new Error(`apps/erp/src/components/upload/upload-state.ts does not exist yet (or fails to import): ${String((err as Error).message).split('\n')[0]}`);
  }
}
type Any = Record<string, unknown> & { status: string };
const file = (name = 'a.jpg') => new File([new Uint8Array([1, 2, 3])], name, { type: 'image/jpeg' });
const deepFreeze = <T extends object>(o: T): T => {
  Object.freeze(o);
  for (const v of Object.values(o)) if (v && typeof v === 'object' && !(v instanceof File)) deepFreeze(v as object);
  return o;
};

async function toUploading(total = 1000, loaded = 0) {
  const m = await load();
  const f = file('compressed.jpg');
  let s = m.reduce(m.initialState(), { type: 'pick', file: file('orig.jpg') } as never) as Any;
  s = m.reduce(s as never, { type: 'compress' } as never) as Any;
  s = m.reduce(s as never, { type: 'compressed', file: f } as never) as Any;
  s = m.reduce(s as never, { type: 'progress', loaded, total } as never) as Any;
  return { m, s, f };
}

describe('T-441 S1 - upload-state: the happy path', () => {
  it('starts empty, or "existing" when the record already has a file', async () => {
    const m = await load();
    expect((m.initialState() as Any).status).toBe('empty');
    const ex = m.initialState({ fileId: 'f1', kind: 'image' } as never) as Any;
    expect(ex.status).toBe('existing');
    expect(ex.fileId).toBe('f1');
    expect(ex.kind).toBe('image');
  });

  it('empty -> selected -> compressing -> uploading -> done, keeping the compressed file for the upload', async () => {
    const m = await load();
    const orig = file('orig.jpg');
    const comp = file('comp.jpg');
    let s = m.reduce(m.initialState(), { type: 'pick', file: orig } as never) as Any;
    expect(s.status).toBe('selected');
    expect(s.file).toBe(orig);
    s = m.reduce(s as never, { type: 'compress' } as never) as Any;
    expect(s.status).toBe('compressing');
    s = m.reduce(s as never, { type: 'compressed', file: comp } as never) as Any;
    expect(s.status).toBe('uploading');
    expect(s.file).toBe(comp);
    expect(s.loaded).toBe(0);
    s = m.reduce(s as never, { type: 'progress', loaded: 400, total: 1000 } as never) as Any;
    expect(s.status).toBe('uploading');
    expect(s.loaded).toBe(400);
    expect(s.total).toBe(1000);
    expect(s.file).toBe(comp);
    s = m.reduce(s as never, { type: 'uploaded', fileId: 'file-1', preview: 'blob:x' } as never) as Any;
    expect(s.status).toBe('done');
    expect(s.fileId).toBe('file-1');
    expect(s.preview).toBe('blob:x');
  });

  it('never mutates the state it is given', async () => {
    const m = await load();
    const f = file();
    const frozen = deepFreeze({ status: 'uploading', file: f, loaded: 1, total: 10 }) as never;
    expect(() => m.reduce(frozen, { type: 'progress', loaded: 5, total: 10 } as never)).not.toThrow();
    expect(() => m.reduce(frozen, { type: 'fail', reason: 'x' } as never)).not.toThrow();
    expect(() => m.reduce(frozen, { type: 'replace' } as never)).not.toThrow();
  });
});

describe('M1 - percent is real, rounds down, and is never 100 before the server answered', () => {
  it('floors loaded/total', async () => {
    const m = await load();
    const at = async (loaded: number, total: number) => m.percent((await toUploading(total, loaded)).s as never);
    expect(await at(421, 1000)).toBe(42);
    expect(await at(1, 3)).toBe(33);
    expect(await at(999, 1000)).toBe(99);
    expect(await at(0, 1000)).toBe(0);
    expect(await at(500, 1000)).toBe(50);
  });

  it('a fully sent body still reads below 100 until `uploaded` arrives', async () => {
    const m = await load();
    const { s } = await toUploading(1000, 1000);
    const p = m.percent(s as never) as number;
    expect(p).toBeLessThan(100);
    expect(p).toBeGreaterThanOrEqual(99);
  });

  it('clamps: over-reporting and negatives stay inside 0..99 while uploading', async () => {
    const m = await load();
    expect(m.percent((await toUploading(1000, 5000)).s as never) as number).toBeLessThan(100);
    expect(m.percent((await toUploading(1000, -50)).s as never)).toBe(0);
  });

  it('is exactly 100 only once done, and 0 for empty', async () => {
    const m = await load();
    const { s } = await toUploading();
    const done = m.reduce(s as never, { type: 'uploaded', fileId: 'f', preview: null } as never);
    expect(m.percent(done)).toBe(100);
    expect(m.percent(m.initialState())).toBe(0);
  });

  it('is null (labelled indeterminate), never a made-up number, when the browser cannot measure (total 0)', async () => {
    const m = await load();
    expect(m.percent((await toUploading(0, 0)).s as never)).toBeNull();
  });
});

describe('M2 - uploading never becomes done without a file id', () => {
  it.each([[''], [undefined], [null]])('uploaded with fileId %j is a failure the person can retry', async (bad) => {
    const { m, s } = await toUploading();
    const next = m.reduce(s as never, { type: 'uploaded', fileId: bad, preview: null } as never) as Any;
    expect(next.status).toBe('failed');
    expect(next.retryable).toBe(true);
    expect(typeof next.reason).toBe('string');
    expect((next.reason as string).length).toBeGreaterThan(0);
  });
});

describe('M3 - a failed upload keeps its file so Retry can resend it', () => {
  it('fail keeps the same File instance and the reason; retry resumes uploading with it from 0', async () => {
    const { m, s, f } = await toUploading(1000, 700);
    const failed = m.reduce(s as never, { type: 'fail', reason: 'Upload interrupted - check the connection and press Retry', retryable: true } as never) as Any;
    expect(failed.status).toBe('failed');
    expect(failed.file).toBe(f);
    expect(failed.reason).toMatch(/interrupted/);
    expect(failed.retryable).toBe(true);
    const again = m.reduce(failed as never, { type: 'retry' } as never) as Any;
    expect(again.status).toBe('uploading');
    expect(again.file).toBe(f);
    expect(again.loaded).toBe(0);
  });

  it('a refusal that cannot succeed on resend (retryable:false) stays failed on retry', async () => {
    const { m, s } = await toUploading();
    const failed = m.reduce(s as never, { type: 'fail', reason: 'That file type is not accepted.', retryable: false } as never) as Any;
    expect(failed.retryable).toBe(false);
    expect((m.reduce(failed as never, { type: 'retry' } as never) as Any).status).toBe('failed');
  });

  it('retry from any other state changes nothing', async () => {
    const { m, s } = await toUploading();
    expect(m.reduce(s as never, { type: 'retry' } as never)).toEqual(s);
    expect((m.reduce(m.initialState(), { type: 'retry' } as never) as Any).status).toBe('empty');
  });
});

describe('M4 - Replace / Remove / unmount abort the in-flight work; late events cannot resurrect it', () => {
  it('shouldAbort is true for replace, remove and unmount while compressing or uploading', async () => {
    const m = await load();
    const { s } = await toUploading();
    for (const t of ['replace', 'remove', 'unmount']) expect(m.shouldAbort(s as never, { type: t } as never)).toBe(true);
    const compressing = m.reduce(m.reduce(m.initialState(), { type: 'pick', file: file() } as never), { type: 'compress' } as never);
    for (const t of ['replace', 'remove', 'unmount']) expect(m.shouldAbort(compressing as never, { type: t } as never)).toBe(true);
  });

  it('shouldAbort is false when nothing is in flight, and for ordinary progress', async () => {
    const m = await load();
    const { s } = await toUploading();
    expect(m.shouldAbort(s as never, { type: 'progress', loaded: 1, total: 2 } as never)).toBe(false);
    expect(m.shouldAbort(m.initialState(), { type: 'replace' } as never)).toBe(false);
    const done = m.reduce(s as never, { type: 'uploaded', fileId: 'f', preview: null } as never);
    expect(m.shouldAbort(done as never, { type: 'replace' } as never)).toBe(false);
    expect(m.shouldAbort(done as never, { type: 'unmount' } as never)).toBe(false);
  });

  it('replace and remove drop the file and return to empty from uploading, done and existing', async () => {
    const m = await load();
    const { s } = await toUploading();
    const done = m.reduce(s as never, { type: 'uploaded', fileId: 'f', preview: 'blob:y' } as never);
    const existing = m.initialState({ fileId: 'f9', kind: 'image' } as never);
    for (const from of [s, done, existing]) {
      for (const t of ['replace', 'remove']) {
        const next = m.reduce(from as never, { type: t } as never) as Any;
        expect(next.status).toBe('empty');
        expect(next.file).toBeUndefined();
        expect(next.fileId).toBeUndefined();
      }
    }
  });

  it('a progress / uploaded / fail that arrives AFTER Replace is ignored (the aborted XHR cannot bring the old photo back)', async () => {
    const { m, s } = await toUploading();
    const emptied = m.reduce(s as never, { type: 'replace' } as never);
    for (const late of [
      { type: 'progress', loaded: 900, total: 1000 },
      { type: 'uploaded', fileId: 'stale', preview: null },
      { type: 'fail', reason: 'late error', retryable: true },
    ]) {
      const next = m.reduce(emptied as never, late as never) as Any;
      expect(next.status).toBe('empty');
    }
  });
});
