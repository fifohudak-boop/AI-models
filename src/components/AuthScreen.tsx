import { useState } from 'react';
import { Button } from './Button';
import { login, signup } from '../lib/api';
import type { User } from '../types';

interface AuthScreenProps {
  onAuthenticated: (user: User) => void;
}

export function AuthScreen({ onAuthenticated }: AuthScreenProps) {
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const user = mode === 'signup' ? await signup(username, password) : await login(username, password);
      onAuthenticated(user);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="ca-auth-screen">
      <div className="ca-panel ca-auth-card">
        <span className="display">Calendar</span>
        <p className="caption ca-auth-subtitle">
          {mode === 'login' ? 'Sign in to your calendar.' : 'Create an account to get your own calendar.'}
        </p>

        <form className="ca-event-form" onSubmit={handleSubmit}>
          <label className="ca-field">
            <span className="caption ca-field-label">Username</span>
            <input
              className="body ca-input"
              type="text"
              value={username}
              autoFocus
              required
              autoComplete="username"
              onChange={(e) => setUsername(e.target.value)}
            />
          </label>
          <label className="ca-field">
            <span className="caption ca-field-label">Password</span>
            <input
              className="body ca-input"
              type="password"
              value={password}
              required
              autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>

          {error && <p className="caption ca-form-error">{error}</p>}

          <Button variant="primary" type="submit" disabled={busy}>
            {busy ? 'Please wait…' : mode === 'login' ? 'Sign in' : 'Create account'}
          </Button>
        </form>

        <button
          type="button"
          className="caption ca-auth-switch"
          onClick={() => {
            setMode((m) => (m === 'login' ? 'signup' : 'login'));
            setError(null);
          }}
        >
          {mode === 'login' ? "Don't have an account? Create one" : 'Already have an account? Sign in'}
        </button>
      </div>
    </div>
  );
}
