import { useState } from 'react';
import type { Session } from '../types';
import { api } from '../api';
import { BRAND } from '../brand';

// Sign in, or create an account (open to anyone with the address while the
// owner keeps sign-up on). "#/signup" opens the sign-up form directly, which is
// the link the owner shares with the team.
export function LoginPage({ session, onLoggedIn }: { session: Session | null; onLoggedIn: (s: Session) => void }) {
  const signupsOpen = session?.signupsOpen ?? false;
  const [mode, setMode] = useState<'signin' | 'signup'>(
    signupsOpen && window.location.hash.startsWith('#/signup') ? 'signup' : 'signin'
  );
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const brand = session?.brand || BRAND.name;
  const ownerHint = mode === 'signin' && session?.ownerNeedsEmail;

  function switchTo(next: 'signin' | 'signup') {
    setMode(next);
    setError(null);
    window.location.hash = next === 'signup' ? '/signup' : '/';
  }

  const canSubmit =
    mode === 'signin'
      ? password.length > 0 && (email.trim().length > 0 || !!session?.ownerNeedsEmail)
      : name.trim().length > 0 && email.trim().length > 0 && password.length >= 8;

  return (
    <div className="center-page">
      <form
        className="card stack"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            const next = mode === 'signin' ? await api.login(email, password) : await api.signup(name, email, password);
            if (window.location.hash.startsWith('#/signup')) window.location.hash = '/post';
            onLoggedIn(next);
          } catch (err) {
            setError((err as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="login-brand">
          <img src="/icon.svg" alt="" />
          <h1>{brand}</h1>
        </div>
        <p className="muted">{mode === 'signin' ? BRAND.tagline : `Create your ${brand} account.`}</p>
        {mode === 'signup' && (
          <label className="field">
            <span>Your name</span>
            <input type="text" autoComplete="name" autoFocus value={name} onChange={(e) => setName(e.target.value)} />
          </label>
        )}
        <label className="field">
          <span>Email</span>
          <input
            type="email"
            autoComplete={mode === 'signin' ? 'username' : 'email'}
            autoFocus={mode === 'signin'}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>
        {ownerHint && (
          <p className="muted small" style={{ marginTop: 4 }}>
            Set up {brand}? Leave the email empty and use your password. Add your email later in Settings.
          </p>
        )}
        <label className="field">
          <span>{mode === 'signup' ? 'Password (at least 8 characters)' : 'Password'}</span>
          <input
            type="password"
            autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        {error && <div className="notice error">{error}</div>}
        <button className="btn primary" disabled={busy || !canSubmit}>
          {busy ? (mode === 'signin' ? 'Signing in…' : 'Creating…') : mode === 'signin' ? 'Sign in' : 'Create account'}
        </button>
        {mode === 'signin' && signupsOpen && (
          <p className="small center-text">
            New here?{' '}
            <button type="button" className="btn link small" onClick={() => switchTo('signup')}>
              Create an account
            </button>
          </p>
        )}
        {mode === 'signup' && (
          <p className="small center-text">
            Already have an account?{' '}
            <button type="button" className="btn link small" onClick={() => switchTo('signin')}>
              Sign in
            </button>
          </p>
        )}
      </form>
    </div>
  );
}
