/**
 * Receipt file checks before any write (S11, design §10.1, §13). File names
 * are untrusted text: they are stored as data and shown as text only.
 */
import { LIMITS } from '../limits';

export type FileCheck = { ok: true } | { ok: false; message: string };

const JPEG_MAGIC = [0xff, 0xd8, 0xff];
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const startsWith = (bytes: Uint8Array, magic: readonly number[]) => magic.every((b, i) => bytes[i] === b);

/** File name for display: at most 200 characters, then "…". */
export function displayFileName(name: string): string {
  return name.length > LIMITS.fileNameDisplayChars ? `${name.slice(0, LIMITS.fileNameDisplayChars)}…` : name;
}

export function checkReceiptFile(name: string, mimeType: string, bytes: Uint8Array): FileCheck {
  if (name.length > LIMITS.fileNameMaxChars) return { ok: false, message: `${name.slice(0, LIMITS.fileNameDisplayChars)}…: file name is too long` };
  if (name.length === 0) return { ok: false, message: 'A file without a name can’t be added.' };
  const shown = displayFileName(name);
  const lower = name.toLowerCase();
  const ext = lower.endsWith('.png') ? 'png' : lower.endsWith('.jpg') || lower.endsWith('.jpeg') ? 'jpeg' : null;
  const mime = mimeType === 'image/png' ? 'png' : mimeType === 'image/jpeg' ? 'jpeg' : null;
  const magic = startsWith(bytes, PNG_MAGIC) ? 'png' : startsWith(bytes, JPEG_MAGIC) ? 'jpeg' : null;
  if (ext === null || mime === null || magic === null || ext !== mime || mime !== magic) {
    return { ok: false, message: `${shown}: not a JPEG or PNG image` };
  }
  if (bytes.length > LIMITS.receiptFileMaxBytes) return { ok: false, message: `${shown}: larger than 10 MB` };
  return { ok: true };
}

export const TOO_MANY_FILES_MESSAGE = `Choose at most ${LIMITS.receiptFilesPerSelection} files at a time.`;
