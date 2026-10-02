import { useState } from 'react';
import type { Status } from '../types';
import { api } from '../api';

export function SetupPage({ status, onDone }: { status: Status; onDone: () => void }) {
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (status.postiz === 'unreachable') {
    return (
      <div className="center-page">
        <div className="card stack">
          <h1>Starting up…</h1>
          <p>
            The Postiz engine isn't answering yet. Right after <code>docker compose up</code> this takes 1–3 minutes.
          </p>
          {status.detail && <div className="notice warn small">{status.detail}</div>}
          <button className="btn primary" onClick={onDone}>
            Try again
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="center-page">
      <form
        className="card stack"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            await api.saveApiKey(key);
            onDone();
          } catch (err) {
            setError((err as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <h1>One-time setup</h1>
        {status.postiz === 'bad-key' && (
          <div className="notice error">
            The saved Postiz API key stopped working{status.apiKeyFromEnv ? ' (it comes from .env — fix it there)' : ''}.
          </div>
        )}
        <ol className="stack" style={{ paddingLeft: 20, margin: 0 }}>
          <li>
            Open{' '}
            <a href={status.postizUrl} target="_blank" rel="noreferrer">
              Postiz
            </a>{' '}
            and <strong>create your account</strong> (only the first sign-up is allowed — that's you).
          </li>
          <li>
            In Postiz, open <strong>Settings → Developers</strong> (Public API) and copy the API key.
          </li>
          <li>Paste it here:</li>
        </ol>
        <input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder="Postiz API key" aria-label="Postiz API key" />
        {error && <div className="notice error">{error}</div>}
        <button className="btn primary" disabled={busy || !key.trim() || status.apiKeyFromEnv}>
          {busy ? 'Checking…' : 'Save and continue'}
        </button>
      </form>
    </div>
  );
}
