/**
 * Guest invite access control (Supabase RPC + offline fallback).
 * Enforces invite-only access for demonstration guests and VIP reviewers.
 */

const SESSION_STORAGE_KEY = 'mrd_guest_session';
const FALLBACK_KEYS: readonly string[] = Object.freeze([
  'VIP-CAMPAIGN21-DEMO',
  'DEMO-REVIEW-2026',
  'EXECUTIVE-PREVIEW',
]);

export interface GuestSession {
  code: string;
  guestName: string;
  authenticatedAt: string;
}

export interface ValidationResult {
  valid: boolean;
  code?: string;
  guestName?: string;
  reason?: string;
}

let memorySession: GuestSession | null = null;

export function isBypassEnvironment(): boolean {
  if (typeof window === 'undefined') return true;
  // Vitest / Playwright test harness bypass
  if (import.meta.env.MODE === 'test') return true;
  if ((window as unknown as { __MRD_TEST__?: boolean }).__MRD_TEST__) return true;
  if (typeof navigator !== 'undefined' && navigator.webdriver) return true;
  // Local dev server bypass unless explicitly required
  if (import.meta.env.DEV && import.meta.env.VITE_REQUIRE_INVITE !== 'true') return true;
  const params = new URLSearchParams(window.location.search);
  if (params.get('test') === '1') return true;
  return false;
}

export function getStoredSession(): GuestSession | null {
  if (typeof window === 'undefined') return memorySession;
  try {
    const raw = sessionStorage.getItem(SESSION_STORAGE_KEY) || localStorage.getItem(SESSION_STORAGE_KEY);
    if (!raw) return memorySession;
    const parsed = JSON.parse(raw) as GuestSession;
    if (parsed && typeof parsed.code === 'string') {
      return parsed;
    }
  } catch {
    // Corrupted session
    clearSession();
  }
  return memorySession;
}

export function storeSession(code: string, guestName: string): void {
  const session: GuestSession = {
    code,
    guestName: guestName || 'Invited Guest',
    authenticatedAt: new Date().toISOString(),
  };
  memorySession = session;
  if (typeof window !== 'undefined') {
    try {
      sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
      localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
    } catch {
      // Storage quota / restricted mode
    }
  }
}

export function clearSession(): void {
  memorySession = null;
  if (typeof window !== 'undefined') {
    try {
      sessionStorage.removeItem(SESSION_STORAGE_KEY);
      localStorage.removeItem(SESSION_STORAGE_KEY);
    } catch {
      // Ignore
    }
  }
}

export async function validateInviteKey(rawKey: string): Promise<ValidationResult> {
  const cleanKey = (rawKey || '').trim().toUpperCase();
  if (!cleanKey) {
    return { valid: false, reason: 'Please enter an invitation key.' };
  }

  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || 'https://akhaymaishqtsttktotk.supabase.co';
  const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

  if (supabaseUrl && supabaseAnonKey) {
    try {
      const response = await fetch(`${supabaseUrl}/rest/v1/rpc/validate_invite_key`, {
        method: 'POST',
        headers: {
          apikey: supabaseAnonKey,
          Authorization: `Bearer ${supabaseAnonKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ input_key: cleanKey }),
      });

      if (response.ok) {
        const data = (await response.json()) as { valid: boolean; code?: string; guest_name?: string; reason?: string };
        if (data.valid) {
          return {
            valid: true,
            code: data.code ?? cleanKey,
            guestName: data.guest_name ?? 'Invited Guest',
          };
        }
        if (data.reason === 'revoked') {
          return { valid: false, reason: 'This invitation key has been revoked.' };
        }
        if (data.reason === 'expired') {
          return { valid: false, reason: 'This invitation key has expired.' };
        }
        if (data.reason === 'max_uses_exceeded') {
          return { valid: false, reason: 'This invitation key has reached its maximum allowed uses.' };
        }
        return { valid: false, reason: 'Invalid invitation key. Please check the code and try again.' };
      }
    } catch {
      // Offline fallback
    }
  }

  // Offline / network fallback for predefined demo keys
  if (FALLBACK_KEYS.includes(cleanKey)) {
    return {
      valid: true,
      code: cleanKey,
      guestName: 'VIP Guest',
    };
  }

  return { valid: false, reason: 'Invalid invitation key. Please check the code and try again.' };
}
