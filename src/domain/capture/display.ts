/**
 * The only domain function that reads `printedText` (S11, safety check S-8).
 * Receipt text is untrusted data: it is returned for plain-text display and is
 * never parsed, interpreted or used to decide anything.
 */
import type { Receipt } from '../schemas';

export const PRINTED_TEXT_NOTE = 'Shown as text only. It cannot change rules or actions.';

export function printedTextForDisplay(receipt: Pick<Receipt, 'printedText'>): string | null {
  const text = receipt.printedText;
  return text === null || text.trim() === '' ? null : text;
}
