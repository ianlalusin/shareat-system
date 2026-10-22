import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(resolve(__dirname, '../../..', path), 'utf8');
const action = (path: string, name: string) => {
  const source = read(path);
  const start = source.indexOf(`export async function ${name}`);
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf('\nexport async function ', start + 10);
  return source.slice(start, end < 0 ? undefined : end);
};

describe('T-441 S2 receipt controls and atomic claims', () => {
  it.each([
    ['customers/[customerId]/AutoAllocateCollectionForm.tsx', 'receiptPhoto'],
    ['inventory/deliveries/NewDeliveryForm.tsx', 'proofPhoto'],
    ['trade/orders/[id]/page.tsx', 'receiptPhoto'],
  ])('%s uses the shared progress control with the record store', (path, name) => {
    const source = read(`apps/erp/src/app/${path}`);
    expect(source).toContain('components/upload/PhotoUpload');
    expect(source).not.toContain('components/PhotoInput');
    expect(source).toMatch(new RegExp(`<PhotoUpload\\s[^>]*name="${name}"[^>]*purpose="receipt_photo"[^>]*storeId=`, 's'));
  });

  it.each([
    ['customers/actions.ts', 'recordCollectionAction', 'receiptPhoto', 'recordCollection', 'collectionId'],
    ['inventory/deliveries/actions.ts', 'createDeliveryAction', 'proofPhoto', 'createDeliveryDocument', 'deliveryId'],
    ['trade/orders/actions.ts', 'dispatchOrderAction', 'receiptPhoto', 'dispatchTradeOrder', 'collectionId'],
  ])('%s resolves both upload paths and claims the actual file owner', (path, name, field, write, owner) => {
    const source = action(`apps/erp/src/app/${path}`, name);
    expect(source).toMatch(new RegExp(`resolveUploadedFile\\(tx, actor, (?:fd|formData), '${field}'`));
    expect(source).not.toMatch(/\buploadFile\(/);
    expect(source).not.toMatch(new RegExp(`(?:fd|formData)\\.get\\('${field}'\\)`));
    expect(source.indexOf('claimUpload(')).toBeGreaterThan(source.indexOf(`${write}(`));
    expect(source).toMatch(new RegExp(`linkTo: (?:saved|dispatched)\\.${owner}`));
  });

  it('trade dispatch exposes the collection owner without inventing an order link', () => {
    const source = read('packages/domain/src/trade/index.ts');
    expect(source).toMatch(/collectionId: string \| null/);
    expect(source).toMatch(/collectionId: billed.collectionId \?\? null/);
  });

  it('the shared resolver still owns the no-JavaScript File fallback', () => {
    const source = read('apps/erp/src/lib/uploaded-file.ts');
    expect(source).toContain('`${name}FileId`');
    expect(source).toContain('instanceof File');
    expect(source).toContain('await uploadFile(');
  });
});
