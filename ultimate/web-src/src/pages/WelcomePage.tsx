import { useState } from 'react';

// First start: no models yet.
export function WelcomePage({ brand, onCreate }: { brand: string; onCreate: (name: string) => Promise<void> }) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="center-page">
      <form
        className="card stack welcome-card"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            await onCreate(name);
          } catch (err) {
            setError((err as Error).message);
            setBusy(false);
          }
        }}
      >
        <div className="login-brand">
          <img src="/icon.svg" alt="" />
          <h1>{brand}</h1>
        </div>
        <p>Everything in one place, with a separate space for every model you run:</p>
        <ul className="welcome-tools">
          <li>
            <strong>Fifofarm</strong> — post one video to all of the model's accounts, with history and analytics.
          </li>
          <li>
            <strong>Reel Finder</strong> — AI agents find videos that look like your references.
          </li>
          <li>
            <strong>AI Studio</strong> — make new videos of the model with Wan 3.0 (Alibaba).
          </li>
        </ul>
        <label className="field">
          <span>Your first model's name</span>
          <input type="text" autoFocus placeholder="e.g. Mia" value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        {error && <div className="notice error small">{error}</div>}
        <button className="btn primary" disabled={busy || !name.trim()}>
          {busy ? 'Creating…' : 'Create model'}
        </button>
        <p className="muted small">You can add more models any time from the switcher at the top.</p>
      </form>
    </div>
  );
}
