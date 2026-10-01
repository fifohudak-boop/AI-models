import { useCallback, useEffect, useRef, useState } from 'react';
import type { Account, Platform, Preferences } from '../types';
import { api } from '../api';
import { AccountAvatar, PlatformBadge } from '../components/AccountAvatar';

// After signing in, these networks ask you to pick a page/channel inside the
// sign-in window, so we must not close it automatically.
const PICKS_INSIDE_POPUP = new Set(['youtube', 'instagram', 'facebook', 'linkedin-page']);

function PinterestBoardPicker({ account, prefs, onSaved }: { account: Account; prefs: Preferences; onSaved: (p: Preferences) => void }) {
  const [boards, setBoards] = useState<{ id: string; name: string }[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api
      .pinterestBoards(account.id)
      .then(setBoards)
      .catch((err) => setError(err.message));
  }, [account.id]);
  if (error) return <div className="batch-error">Couldn't load boards: {error}</div>;
  if (!boards) return <div className="muted small">Loading boards…</div>;
  return (
    <label className="field small" style={{ marginTop: 6 }}>
      <span>Post to board</span>
      <select
        value={prefs.pinterestBoards[account.id] ?? ''}
        onChange={async (e) => onSaved(await api.savePreferences({ pinterestBoards: { [account.id]: e.target.value } }))}
      >
        <option value="">Choose a board…</option>
        {boards.map((b) => (
          <option key={b.id} value={b.id}>
            {b.name}
          </option>
        ))}
      </select>
    </label>
  );
}

function BlueskyForm({ onConnected }: { onConnected: () => void }) {
  const [handle, setHandle] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="stack"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          await api.connectBluesky(handle, password);
          setHandle('');
          setPassword('');
          onConnected();
        } catch (err) {
          setError((err as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <input type="text" placeholder="you.bsky.social" value={handle} onChange={(e) => setHandle(e.target.value)} aria-label="Bluesky handle" />
      <input
        type="password"
        placeholder="App password (xxxx-xxxx-xxxx-xxxx)"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        aria-label="Bluesky app password"
      />
      <div className="muted small">
        Make one in Bluesky: Settings → Privacy and security → App passwords. Don't use your real password.
      </div>
      {error && <div className="notice error">{error}</div>}
      <button className="btn primary small" disabled={busy || !handle || !password}>
        {busy ? 'Connecting…' : 'Connect Bluesky'}
      </button>
    </form>
  );
}

export function AccountsPage({ postizUrl, toast }: { postizUrl: string; toast: (msg: string) => void }) {
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [platforms, setPlatforms] = useState<Platform[]>([]);
  const [prefs, setPrefs] = useState<Preferences | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState<string | null>(null);
  const [showBluesky, setShowBluesky] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    try {
      setAccounts(await api.accounts());
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    refresh();
    api
      .platforms()
      .then((list) => setPlatforms([...list].sort((a, b) => Number(b.configured) - Number(a.configured))))
      .catch(() => {});
    api.preferences().then(setPrefs).catch(() => {});
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [refresh]);

  async function connect(platform: Platform) {
    // Open the window right away (inside the click) so pop-up blockers allow it.
    const popup = window.open('about:blank', 'autopost-connect', 'width=640,height=780');
    setConnecting(platform.identifier);
    setError(null);
    let url: string;
    try {
      url = (await api.connectUrl(platform.identifier)).url;
    } catch (err) {
      popup?.close();
      setConnecting(null);
      setError((err as Error).message);
      return;
    }
    if (popup) popup.location.href = url;
    else window.open(url, '_blank');

    const before = new Set((accounts ?? []).map((a) => a.id));
    const started = Date.now();
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      let list: Account[];
      try {
        list = await api.accounts();
      } catch {
        return;
      }
      const added = list.filter((a) => !before.has(a.id));
      const popupGone = !popup || popup.closed;
      if (added.length > 0 || popupGone || Date.now() - started > 10 * 60 * 1000) {
        setAccounts(list);
        if (added.length > 0) {
          toast(`Connected ${added.map((a) => a.name).join(', ')}`);
          if (!PICKS_INSIDE_POPUP.has(platform.identifier)) popup?.close();
        }
        if (popupGone || added.length > 0) {
          clearInterval(pollRef.current!);
          pollRef.current = null;
          setConnecting(null);
        }
      }
    }, 2000);
  }

  async function remove(account: Account) {
    if (!window.confirm(`Disconnect ${account.name} (${account.platform})? Its scheduled posts are cancelled.`)) return;
    try {
      await api.removeAccount(account.id);
      toast(`Disconnected ${account.name}`);
      refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div>
      <section className="card">
        <div className="card-head">
          <h2>Connected accounts</h2>
          <button className="btn small" onClick={refresh}>
            Refresh
          </button>
        </div>
        {error && (
          <div className="notice error" style={{ marginBottom: 10 }}>
            {error}
          </div>
        )}
        {accounts === null ? (
          <p className="muted">Loading…</p>
        ) : accounts.length === 0 ? (
          <p className="muted">Nothing connected yet — pick a network below.</p>
        ) : (
          <div className="account-list">
            {accounts.map((a) => (
              <div className="account" key={a.id}>
                <AccountAvatar name={a.name} picture={a.picture} identifier={a.identifier} />
                <div className="account-main">
                  <div className="account-name">{a.name}</div>
                  <div className="account-meta">
                    {a.platform}
                    {a.profile && ` · @${a.profile}`}
                    {a.disabled && ' · disabled'}
                    {!a.supported && ' · post to this one from Postiz'}
                  </div>
                  {a.identifier === 'pinterest' && prefs && <PinterestBoardPicker account={a} prefs={prefs} onSaved={setPrefs} />}
                </div>
                <button className="btn danger small" onClick={() => remove(a)}>
                  Disconnect
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="card">
        <h2>Connect an account</h2>
        <p className="muted small">
          A sign-in window opens for the network. Approve access there — this page updates by itself. Connect as many
          accounts per network as you like (sign out of the first one inside the window to add another).
        </p>
        {connecting && (
          <div className="notice info" style={{ marginBottom: 10 }}>
            Waiting for you to finish in the sign-in window… (close it to cancel)
          </div>
        )}
        <div className="platform-grid">
          {platforms.map((p) => (
            <div className="platform-tile" key={p.identifier}>
              <div className="row">
                <PlatformBadge identifier={p.identifier} />
                <strong>{p.name}</strong>
              </div>
              {p.connect === 'credentials' ? (
                showBluesky ? (
                  <BlueskyForm
                    onConnected={() => {
                      toast('Connected Bluesky');
                      setShowBluesky(false);
                      refresh();
                    }}
                  />
                ) : (
                  <button className="btn small" onClick={() => setShowBluesky(true)}>
                    Connect
                  </button>
                )
              ) : p.configured ? (
                <button className="btn small" disabled={connecting !== null} onClick={() => connect(p)}>
                  {connecting === p.identifier ? 'Connecting…' : 'Connect'}
                </button>
              ) : (
                <div className="muted small">
                  Needs developer keys first: <code>{p.missingKeys.join(', ')}</code> in <code>.env</code> (see
                  docs/connect-platforms.md).
                </div>
              )}
            </div>
          ))}
        </div>
        <p className="muted small" style={{ marginTop: 12 }}>
          Other networks (Reddit, Discord, Telegram, Google Business…) can be connected in{' '}
          <a href={`${postizUrl}/launches`} target="_blank" rel="noreferrer">
            Postiz
          </a>
          .
        </p>
      </section>
    </div>
  );
}
