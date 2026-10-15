import { useState, type FormEvent } from 'react';
import { api } from '../api';

// Shown to people reaching the app from outside the Mac (on the share address). On the Mac itself
// you're the owner and never see this.
export function LoginPage({ brand, onDone }: { brand: string; onDone: () => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.login(username.trim(), password);
      onDone();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="center-page">
      <form className="card stack login-card" onSubmit={submit}>
        <div className="brand">
          <img className="brand-logo" src="/icon.svg" alt="" />
          <span className="brand-name">{brand}</span>
        </div>
        <h1>Sign in</h1>
        <label className="stack-sm">
          <span className="muted small">Username</span>
          <input
            type="text"
            autoFocus
            autoComplete="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
        </label>
        <label className="stack-sm">
          <span className="muted small">Password</span>
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        {error && <div className="notice error small">{error}</div>}
        <button className="btn primary" disabled={busy || !username.trim() || !password}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
        <p className="muted small">The owner of this {brand} sets up your account and the models you can use.</p>
      </form>
    </div>
  );
}
