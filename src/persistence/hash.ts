/** SHA-256 of file bytes via Web Crypto (design §10.1). Needs a secure context (HTTPS or localhost). */
export function hasSubtleCrypto(): boolean {
  return typeof globalThis.crypto !== 'undefined' && typeof globalThis.crypto.subtle?.digest === 'function';
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export const NEEDS_SECURE_CONTEXT = 'This page needs HTTPS or localhost to add files or load the demo.';
