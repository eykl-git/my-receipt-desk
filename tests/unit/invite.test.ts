import { describe, expect, it, beforeEach } from 'vitest';
import {
  clearSession,
  getStoredSession,
  storeSession,
  validateInviteKey,
} from '../../src/auth/invite';

describe('Invite Access Gate', () => {
  beforeEach(() => {
    clearSession();
  });

  it('stores and retrieves session correctly', () => {
    expect(getStoredSession()).toBeNull();
    storeSession('VIP-DEMO', 'VIP Guest');
    const session = getStoredSession();
    expect(session).not.toBeNull();
    expect(session?.code).toBe('VIP-DEMO');
    expect(session?.guestName).toBe('VIP Guest');
    clearSession();
    expect(getStoredSession()).toBeNull();
  });

  it('rejects empty or whitespace keys', async () => {
    const res1 = await validateInviteKey('');
    expect(res1.valid).toBe(false);
    const res2 = await validateInviteKey('   ');
    expect(res2.valid).toBe(false);
  });

  it('rejects unknown invite keys', async () => {
    const res = await validateInviteKey('INVALID-KEY-12345');
    expect(res.valid).toBe(false);
  });

  it('accepts fallback demo key offline', async () => {
    const res = await validateInviteKey('VIP-CAMPAIGN21-DEMO');
    expect(res.valid).toBe(true);
    expect(res.code).toBe('VIP-CAMPAIGN21-DEMO');
  });
});
