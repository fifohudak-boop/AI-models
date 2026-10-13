import { useEffect, useState } from 'react';
import type { AppStatus } from '../types';
import { api } from '../api';

// Connects Ultimate to the posting engine (Postiz) your Fifofarm server runs, so posting,
// accounts, history and analytics work here too. Nothing in Fifofarm changes.
export function EngineSetup({
  status,
  onDone,
  toast,
  compact = false,
}: {
  status: AppStatus;
  onDone: () => void;
  toast: (m: string) => void;
  compact?: boolean;
}) {
  const [url, setUrl] = useState(status.engine.url || '');
  const [how, setHow] = useState<'key' | 'login'>('key');
  const [apiKey, setApiKey] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!url && status.engine.url) setUrl(status.engine.url);
  }, [status.engine.url, url]);

  const state = status.engine.state;
  const canSubmit = url.trim().length > 8 && (how === 'key' ? apiKey.trim().length > 4 : !!email.trim() && !!password);

  return (
    <section className="card stack">
      <div className="card-head" style={{ marginBottom: 0 }}>
        <h2>Posting engine</h2>
        {state === 'ok' ? (
          <span className="chip published">connected</span>
        ) : state === 'not-connected' ? (
          <span className="chip">not connected</span>
        ) : (
          <span className="chip failed">{state === 'bad-key' ? 'key not accepted' : "can't reach it"}</span>
        )}
      </div>
      {!compact && (
        <p className="small">
          Fifofarm posts through its posting engine (Postiz) on your server. Connect Ultimate to the same engine and the
          Post, Accounts, History and Analytics tabs work here too — with each model's own accounts. Fifofarm itself
          stays exactly as it is.
        </p>
      )}
      {state === 'ok' && <p className="small muted">Connected to {status.engine.url}.</p>}
      {state !== 'ok' && status.engine.detail && <div className="notice warn small">{status.engine.detail}</div>}
      <form
        className="stack"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            await api.connectEngine(how === 'key' ? { url, apiKey } : { url, email, password });
            setApiKey('');
            setPassword('');
            toast('Posting engine connected');
            onDone();
          } catch (err) {
            setError((err as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <label className="field">
          <span>Engine address</span>
          <input
            type="text"
            placeholder="https://postiz.yourname.duckdns.org"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            spellCheck={false}
          />
        </label>
        <div className="segmented" role="radiogroup" aria-label="How to connect">
          <button type="button" role="radio" aria-checked={how === 'key'} className={how === 'key' ? 'on' : ''} onClick={() => setHow('key')}>
            Paste the API key
          </button>
          <button type="button" role="radio" aria-checked={how === 'login'} className={how === 'login' ? 'on' : ''} onClick={() => setHow('login')}>
            Use the Postiz login
          </button>
        </div>
        {how === 'key' ? (
          <>
            <label className="field">
              <span>Postiz API key</span>
              <input type="password" autoComplete="off" value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
            </label>
            <p className="muted small">
              In Postiz (the engine address above) open Settings → Public API and copy the key.
            </p>
          </>
        ) : (
          <>
            <div className="row2">
              <label className="field">
                <span>Postiz email</span>
                <input type="email" autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} />
              </label>
              <label className="field">
                <span>Postiz password</span>
                <input type="password" autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} />
              </label>
            </div>
            <p className="muted small">
              Fifofarm shows this login under Settings → Posting engine → "Show the Postiz login". Ultimate signs in once,
              reads the API key and forgets the password.
            </p>
          </>
        )}
        {error && <div className="notice error small">{error}</div>}
        <div className="row">
          <button className="btn primary" disabled={busy || !canSubmit}>
            {busy ? 'Connecting…' : state === 'ok' ? 'Reconnect' : 'Connect'}
          </button>
        </div>
      </form>
    </section>
  );
}
