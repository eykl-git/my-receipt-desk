import { useState, useEffect, type FormEvent, type ReactNode } from 'react';
import { store } from '../store';
import {
  clearSession,
  getStoredSession,
  isBypassEnvironment,
  storeSession,
  validateInviteKey,
  type GuestSession,
} from '../../auth/invite';

interface InviteGateProps {
  children: ReactNode;
}

export function InviteGate({ children }: InviteGateProps) {
  const [session, setSession] = useState<GuestSession | null>(() => {
    if (isBypassEnvironment()) {
      return { code: 'BYPASS', guestName: 'Tester', authenticatedAt: new Date().toISOString() };
    }
    return getStoredSession();
  });
  const [inputKey, setInputKey] = useState('');
  const [loading, setLoading] = useState(() => {
    if (typeof window === 'undefined') return false;
    const params = new URLSearchParams(window.location.search);
    return Boolean(params.get('key') || params.get('invite'));
  });
  const [error, setError] = useState<string | null>(null);

  // Check 1-click VIP link in URL: ?key=... or ?invite=...
  useEffect(() => {
    if (session || typeof window === 'undefined') return;

    const params = new URLSearchParams(window.location.search);
    const directKey = params.get('key') || params.get('invite');

    if (directKey) {
      void validateInviteKey(directKey)
        .then((result) => {
          if (result.valid && result.code) {
            storeSession(result.code, result.guestName || 'VIP Guest');
            setSession({
              code: result.code,
              guestName: result.guestName || 'VIP Guest',
              authenticatedAt: new Date().toISOString(),
            });
            // Clean URL query parameters to avoid leaking key
            params.delete('key');
            params.delete('invite');
            const cleanSearch = params.toString() ? `?${params.toString()}` : '';
            window.history.replaceState({}, '', `${window.location.pathname}${cleanSearch}${window.location.hash}`);
            void store.tryDemo();
          } else {
            setError(result.reason || 'Invalid invitation key.');
          }
        })
        .catch(() => {
          setError('Unable to verify invitation key. Please check your connection.');
        })
        .finally(() => {
          setLoading(false);
        });
    }
  }, [session]);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!inputKey.trim() || loading) return;

    setLoading(true);
    setError(null);

    try {
      const result = await validateInviteKey(inputKey);
      if (result.valid && result.code) {
        storeSession(result.code, result.guestName || 'Invited Guest');
        setSession({
          code: result.code,
          guestName: result.guestName || 'Invited Guest',
          authenticatedAt: new Date().toISOString(),
        });
        void store.tryDemo();
      } else {
        setError(result.reason || 'Invalid invitation key.');
      }
    } catch {
      setError('Unable to verify invitation key. Please check your connection.');
    } finally {
      setLoading(false);
    }
  };

  const handleLogout = () => {
    clearSession();
    setSession(null);
    setInputKey('');
    setError(null);
  };

  // If authenticated, render app with session context
  if (session) {
    return (
      <>
        {children}
        {session.code !== 'BYPASS' && (
          <div className="invite-session-bar" aria-label="Guest session status">
            <span className="invite-session-guest">
              Guest: <strong>{session.guestName}</strong>
            </span>
            <button
              type="button"
              className="invite-session-exit"
              onClick={handleLogout}
              title="Sign out of guest session"
            >
              Exit preview
            </button>
          </div>
        )}
      </>
    );
  }

  // Not authenticated: render the Private Access Gate
  return (
    <div className="invite-gate-overlay">
      <div className="invite-gate-card">
        <div className="invite-gate-header">
          <div className="invite-gate-badge">Campaign 21 • Private Access</div>
          <h1 className="invite-gate-title">My Receipt Desk</h1>
          <p className="invite-gate-subtitle">
            Receipt-to-statement reconciliation prototype with continuous knowledge learning.
          </p>
        </div>

        <form className="invite-gate-form" onSubmit={handleSubmit}>
          <label htmlFor="invite-key-input" className="invite-gate-label">
            Invitation Key
          </label>
          <div className="invite-gate-input-row">
            <input
              id="invite-key-input"
              type="text"
              className="invite-gate-input"
              value={inputKey}
              onChange={(e) => {
                setInputKey(e.target.value);
                if (error) setError(null);
              }}
              placeholder="e.g. VIP-CAMPAIGN21-DEMO"
              autoFocus
              autoComplete="off"
              spellCheck={false}
              disabled={loading}
            />
            <button type="submit" className="invite-gate-submit" disabled={loading || !inputKey.trim()}>
              {loading ? 'Verifying…' : 'Enter'}
            </button>
          </div>

          {error && <div className="invite-gate-error">{error}</div>}
        </form>

        <div className="invite-gate-footer">
          <p className="invite-gate-note">
            This deployment is strictly confidential and reserved for invited demonstration guests and reviewers.
          </p>
        </div>
      </div>
    </div>
  );
}
