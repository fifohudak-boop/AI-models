import { useEffect, useState } from 'react';
import type { Status } from '../types';
import { api } from '../api';

// Shown until the posting engine (Postiz) is connected. On a fresh install
// Fifofarm creates the Postiz account and key by itself; this page just waits.
export function SetupPage({ status, isOwner, onDone }: { status: Status; isOwner: boolean; onDone: () => void }) {
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const waiting =
    status.postiz === 'unreachable' ||
    (status.postiz === 'no-key' && (status.autoSetup === 'waiting' || status.autoSetup === 'idle'));

  // Check again every 10 s while the engine starts.
  useEffect(() => {
    if (!waiting) return;
    const handle = setInterval(onDone, 10_000);
    return () => clearInterval(handle);
  }, [waiting, onDone]);

  if (waiting) {
    return (
      <div className="center-page">
        <div className="card stack">
          <h1>Getting {status.brand} ready…</h1>
          <p>
            The posting engine is starting. The very first start takes up to 10 minutes; after that it's a minute at most.
            This page continues by itself.
          </p>
          {status.detail && <div className="notice warn small">{status.detail}</div>}
          <div className="progress indeterminate">
            <div />
          </div>
        </div>
      </div>
    );
  }

  if (!isOwner) {
    return (
      <div className="center-page">
        <div className="card stack">
          <h1>{status.brand} isn't ready yet</h1>
          <p>The owner of this {status.brand} still has to finish connecting the posting engine. Try again a bit later.</p>
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
        <h1>Connect the posting engine</h1>
        {status.postiz === 'bad-key' && (
          <div className="notice error">
            The saved Postiz API key stopped working{status.apiKeyFromEnv ? ' (it comes from .env — fix it there)' : ''}.
          </div>
        )}
        {status.autoSetup === 'error' && (
          <div className="notice warn small">
            Automatic setup didn't work{status.detail ? ` (${status.detail})` : ''}.{' '}
            <button
              type="button"
              className="btn link small"
              onClick={async () => {
                await api.autoSetup().catch(() => {});
                onDone();
              }}
            >
              Try again
            </button>
          </div>
        )}
        <ol className="stack" style={{ paddingLeft: 20, margin: 0 }}>
          <li>
            Open{' '}
            <a href={status.postizUrl} target="_blank" rel="noreferrer">
              Postiz
            </a>{' '}
            and sign in (an account already exists there).
          </li>
          <li>
            In Postiz, open <strong>Settings → Developers</strong> and copy the API key.
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
