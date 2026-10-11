import { useState } from 'react';
import type { Session } from '../types';
import { api } from '../api';
import { BRAND } from '../brand';
import { initialsOf } from '../format';
import { SIGNUP_HASH, isSignupLink } from '../links';

// The sign-up link opened in a browser where someone is already signed in
// (a shared computer, the owner's phone…). Without this, the newcomer would
// silently land in that person's account and use it as their own.
export function AlreadySignedIn({
  session,
  onSignOut,
  onContinue,
}: {
  session: Session;
  onSignOut: () => void;
  onContinue: () => void;
}) {
  const user = session.user!;
  const brand = session.brand || BRAND.name;
  const first = user.name.split(/\s+/)[0] || user.name;
  const [busy, setBusy] = useState(false);
  return (
    <div className="center-page">
      <div className="card stack">
        <div className="login-brand">
          <img src="/icon.svg" alt="" />
          <h1>{brand}</h1>
        </div>
        <h2>This browser is already signed in</h2>
        <div className="row" style={{ flexWrap: 'nowrap' }}>
          <span className="me-avatar big" aria-hidden="true">
            {initialsOf(user.name)}
          </span>
          <div style={{ minWidth: 0 }}>
            <strong>{user.name}</strong>
            {user.email && <div className="muted small account-popover-email">{user.email}</div>}
          </div>
        </div>
        {session.signupsOpen ? (
          <p className="small">
            This link creates a <strong>new, separate</strong> {brand} account. If you aren't {first}, sign out first —
            otherwise you'd be posting from {first}'s account.
          </p>
        ) : (
          <p className="small">
            This is a sign-up link, but sign-up is closed right now — ask the owner of this {brand} to open it. If you
            aren't {first}, sign out.
          </p>
        )}
        <button
          className="btn primary block"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            onSignOut();
          }}
        >
          {busy ? 'Signing out…' : session.signupsOpen ? 'Sign out and create a new account' : `Sign out ${first}`}
        </button>
        <button className="btn block" onClick={onContinue}>
          I'm {first} — continue
        </button>
      </div>
    </div>
  );
}

// Sign in, or create an account (open to anyone with the address while the
// owner keeps sign-up on). "#/signup" opens the sign-up form directly, which is
// the link the owner shares with the team.
export function LoginPage({ session, onLoggedIn }: { session: Session | null; onLoggedIn: (s: Session) => void }) {
  const signupsOpen = session?.signupsOpen ?? false;
  const [mode, setMode] = useState<'signin' | 'signup'>(signupsOpen && isSignupLink() ? 'signup' : 'signin');
  const closedLink = !signupsOpen && isSignupLink();
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
    window.location.hash = next === 'signup' ? SIGNUP_HASH : '/';
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
            if (isSignupLink()) window.location.hash = '/post';
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
        <p className="muted">
          {mode === 'signin' ? BRAND.tagline : `Create your own ${brand} account — the accounts you connect stay yours.`}
        </p>
        {closedLink && mode === 'signin' && (
          <div className="notice warn small">
            Sign-up is closed right now. Ask the owner of this {brand} to open it, or sign in if you already have an
            account.
          </div>
        )}
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
