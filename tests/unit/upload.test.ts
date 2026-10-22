/** My files receipt capture: file checks, duplicate uploads, manual entry (design §10.1, §13). */
import { describe, expect, it } from 'vitest';
import { checkReceiptFile, displayFileName } from '../../src/domain/capture/upload';
import { validateFieldInput } from '../../src/domain/capture/edit';
import { captureStatus } from '../../src/domain/capture/fields';
import { LIMITS } from '../../src/domain/limits';
import { describeEachRepo, makeRepo } from '../helpers/repos';
import { addReceipts, saveFields, FieldValidationError } from '../../src/persistence/commands';
import { sha256Hex } from '../../src/persistence/hash';
import { deriveWorkspaceView } from '../../src/domain/views';
import { asWorkspaceState } from '../../src/persistence/commands/context';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9, 9]);

describe('receipt file checks', () => {
  it('accepts JPEG and PNG only, checked by extension, MIME type and magic bytes', () => {
    expect(checkReceiptFile('a.png', 'image/png', PNG)).toEqual({ ok: true });
    expect(checkReceiptFile('a.JPG', 'image/jpeg', JPEG)).toEqual({ ok: true });
    expect(checkReceiptFile('a.jpeg', 'image/jpeg', JPEG)).toEqual({ ok: true });
    expect(checkReceiptFile('fake.png', 'image/png', new TextEncoder().encode('hello'))).toEqual({ ok: false, message: 'fake.png: not a JPEG or PNG image' });
    expect(checkReceiptFile('a.pdf', 'application/pdf', PNG)).toEqual({ ok: false, message: 'a.pdf: not a JPEG or PNG image' });
    expect(checkReceiptFile('a.png', 'image/jpeg', PNG).ok).toBe(false);
  });

  it('enforces the 10 MB and file-name limits with messages naming them', () => {
    const big = new Uint8Array(LIMITS.receiptFileMaxBytes + 1);
    big.set(PNG);
    expect(checkReceiptFile('big.png', 'image/png', big)).toEqual({ ok: false, message: 'big.png: larger than 10 MB' });
    const long = `${'x'.repeat(1001)}.png`;
    expect(checkReceiptFile(long, 'image/png', PNG)).toEqual({ ok: false, message: `${'x'.repeat(200)}…: file name is too long` });
    expect(displayFileName('y'.repeat(250))).toBe(`${'y'.repeat(200)}…`);
  });
});

describeEachRepo('manual entry', () => {
  it('validates the four fields and never parses amounts as floats', () => {
    expect(validateFieldInput({ merchant: 'Morning Cup', date: '2026-04-05', amount: '48.10', currency: 'HKD' })).toEqual({
      ok: true,
      values: { merchant: 'Morning Cup', date: '2026-04-05', amountMinor: 4810, currency: 'HKD' },
    });
    const bad = validateFieldInput({ merchant: '', date: '2026-02-30', amount: '1e3', currency: 'hk' });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(Object.keys(bad.errors).sort()).toEqual(['amountMinor', 'currency', 'date', 'merchant']);
  });

  it('T10 re-adding an identical file creates no receipt and is audited; saved fields validate capture', async () => {
    const repo = makeRepo('personal', { systemNow: () => '2026-04-20T10:00:00.000Z' });
    const upload = { fileName: 'lunch.png', mimeType: 'image/png', bytes: PNG, sha256: await sha256Hex(PNG) };
    expect(await addReceipts(repo, [upload])).toEqual({ added: ['R-0001'], duplicates: [] });
    expect(await addReceipts(repo, [{ ...upload, fileName: 'lunch copy.png' }])).toEqual({ added: [], duplicates: [{ fileName: 'lunch copy.png', matchedReceiptId: 'R-0001' }] });
    let s = await repo.loadSnapshot();
    expect(s.receipts).toHaveLength(1);
    expect(s.audit.map((a) => a.action)).toEqual(['capture.receipt_added', 'capture.duplicate_upload_rejected']);
    expect(captureStatus(s.receipts[0]!)).toBe('needs_review');
    expect(s.receipts[0]!.fields.merchant.original.provenance.kind).toBe('manual');

    await expect(saveFields(repo, 'R-0001', { merchant: '', date: '2026-04-05', amount: '48', currency: 'HKD' })).rejects.toBeInstanceOf(FieldValidationError);
    await saveFields(repo, 'R-0001', { merchant: 'Morning Cup', date: '2026-04-05', amount: '48', currency: 'HKD' });
    s = await repo.loadSnapshot();
    const r = s.receipts[0]!;
    expect(captureStatus(r)).toBe('validated');
    expect(r.fields.amountMinor.original.value).toBeNull(); // the original is never overwritten
    expect(r.fields.amountMinor.correction?.value).toBe(4800);
    expect(r.canonicalMerchantId).toBe('m:morning-cup');
    expect(s.audit.at(-1)!.action).toBe('capture.fields_confirmed');
    const view = deriveWorkspaceView(asWorkspaceState(s));
    expect(view.caseById.get('R-0001')!.explanation).toBe('No card transaction with this amount and date yet');
  });
});
