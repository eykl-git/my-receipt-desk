import { describe, expect, it } from 'vitest';
import { checkTextLength, LIMITS } from '../../src/domain/limits';
import { isAmountInRange } from '../../src/domain/money';
import { isDateInSupportedRange, type IsoDate } from '../../src/domain/dates';
import { MinorUnitsSchema } from '../../src/domain/schemas';

describe('documented limits (domain)', () => {
  it('limits are constants matching design §13', () => {
    expect(Object.isFrozen(LIMITS)).toBe(true);
    expect(LIMITS.receiptFileMaxBytes).toBe(10 * 1024 * 1024);
    expect(LIMITS.receiptFilesPerSelection).toBe(20);
    expect(LIMITS.csvMaxBytes).toBe(2 * 1024 * 1024);
    expect(LIMITS.csvMaxDataRows).toBe(2000);
    expect(LIMITS.csvMaxColumns).toBe(30);
    expect(LIMITS.workspaceMaxReceipts).toBe(500);
    expect(LIMITS.workspaceMaxTransactions).toBe(2000);
    expect(LIMITS.workspaceMaxRules).toBe(200);
    expect(LIMITS.recordAllReadyMaxCases).toBe(50);
    expect(LIMITS.postingWindowMaxDays).toBe(7);
    expect(LIMITS.postingWindowDefaultDays).toBe(3);
  });

  it('text length limits are enforced with messages naming the limit', () => {
    expect(checkTextLength('merchant', 'x'.repeat(120))).toBeNull();
    expect(checkTextLength('merchant', 'x'.repeat(121))).toBe('Merchant must be at most 120 characters.');
    expect(checkTextLength('merchant', '   ')).toBe('Merchant must be at least 1 character.');
    expect(checkTextLength('reason', 'ab')).toBe('Reason must be at least 3 characters.');
    expect(checkTextLength('reason', 'abc')).toBeNull();
    expect(checkTextLength('reason', 'x'.repeat(501))).toBe('Reason must be at most 500 characters.');
    expect(checkTextLength('accountName', 'x'.repeat(40))).toBeNull();
    expect(checkTextLength('accountName', 'x'.repeat(41))).toBe('Card account name must be at most 40 characters.');
    expect(checkTextLength('invoiceNumber', 'x'.repeat(41))).toBe('Invoice number must be at most 40 characters.');
    expect(checkTextLength('printedText', 'x'.repeat(2001))).toBe('Printed text must be at most 2000 characters.');
    expect(checkTextLength('fileName', 'x'.repeat(1000))).toBeNull();
    expect(checkTextLength('fileName', 'x'.repeat(1001))).toBe('File name must be at most 1000 characters.');
  });

  it('money range is HKD 0.01 to 9,999,999.99 per item', () => {
    expect(isAmountInRange(0)).toBe(false);
    expect(isAmountInRange(1)).toBe(true);
    expect(isAmountInRange(999_999_999)).toBe(true);
    expect(isAmountInRange(1_000_000_000)).toBe(false);
    expect(isAmountInRange(1.5)).toBe(false);
    expect(MinorUnitsSchema.safeParse(0).success).toBe(false);
    expect(MinorUnitsSchema.safeParse(1_000_000_000).success).toBe(false);
    expect(MinorUnitsSchema.safeParse(48.5).success).toBe(false);
  });

  it('dates are limited to 2000-01-01 … 2099-12-31', () => {
    expect(isDateInSupportedRange('1999-12-31' as IsoDate)).toBe(false);
    expect(isDateInSupportedRange('2000-01-01' as IsoDate)).toBe(true);
    expect(isDateInSupportedRange('2099-12-31' as IsoDate)).toBe(true);
    expect(isDateInSupportedRange('2100-01-01' as IsoDate)).toBe(false);
  });
});
