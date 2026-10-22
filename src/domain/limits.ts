/** Documented limits (design §13). Each one has a test and an error message naming it. */
export const LIMITS = Object.freeze({
  receiptFileMaxBytes: 10 * 1024 * 1024,
  receiptFilesPerSelection: 20,
  csvMaxBytes: 2 * 1024 * 1024,
  csvMaxDataRows: 2000,
  csvMaxColumns: 30,
  csvCellMaxChars: 500,
  csvDescriptionMaxChars: 200,
  workspaceMaxReceipts: 500,
  workspaceMaxTransactions: 2000,
  workspaceMaxRules: 200,
  merchantMinChars: 1,
  merchantMaxChars: 120,
  reasonMinChars: 3,
  reasonMaxChars: 500,
  accountNameMinChars: 1,
  accountNameMaxChars: 40,
  invoiceNumberMaxChars: 40,
  printedTextMaxChars: 2000,
  fileNameMaxChars: 1000,
  fileNameDisplayChars: 200,
  amountMinMinor: 1,
  amountMaxMinor: 999_999_999,
  dateMin: '2000-01-01',
  dateMax: '2099-12-31',
  recordAllReadyMaxCases: 50,
  knowledgeJsonMaxBytes: 1024 * 1024,
  knowledgeJsonMaxRules: 200,
  postingWindowMaxDays: 7,
  postingWindowDefaultDays: 3,
  aliasLabelMinChars: 4,
  aliasLabelMaxChars: 60,
});

export type TextLimitField = 'merchant' | 'reason' | 'accountName' | 'invoiceNumber' | 'printedText' | 'fileName';

const TEXT_BOUNDS: Record<TextLimitField, { min: number; max: number; label: string }> = {
  merchant: { min: LIMITS.merchantMinChars, max: LIMITS.merchantMaxChars, label: 'Merchant' },
  reason: { min: LIMITS.reasonMinChars, max: LIMITS.reasonMaxChars, label: 'Reason' },
  accountName: { min: LIMITS.accountNameMinChars, max: LIMITS.accountNameMaxChars, label: 'Card account name' },
  invoiceNumber: { min: 0, max: LIMITS.invoiceNumberMaxChars, label: 'Invoice number' },
  printedText: { min: 0, max: LIMITS.printedTextMaxChars, label: 'Printed text' },
  fileName: { min: 1, max: LIMITS.fileNameMaxChars, label: 'File name' },
};

/** Returns null when the (trimmed) text fits, otherwise a message naming the limit. */
export function checkTextLength(field: TextLimitField, value: string): string | null {
  const { min, max, label } = TEXT_BOUNDS[field];
  const len = field === 'reason' || field === 'merchant' ? value.trim().length : value.length;
  if (len < min) return `${label} must be at least ${min} character${min === 1 ? '' : 's'}.`;
  if (len > max) return `${label} must be at most ${max} characters.`;
  return null;
}
