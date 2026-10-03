import { useCallback, useEffect, useRef, useState } from 'react';
import type { Account, NetworksInfo, Platform, Preferences } from '../types';
import { api } from '../api';
import { AccountAvatar, PlatformBadge } from '../components/AccountAvatar';
import { CopyField } from '../components/CopyField';
import { copyText } from '../clipboard';
import { NetworkSetupPanel } from '../components/NetworkSetupPanel';

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

// What to do before adding another Instagram account (Meta's rule while the
// app hasn't passed App Review).
function InstagramExtraHelp() {
  return (
    <div className="notice info small stack">
      <strong>Adding another Instagram account</strong>
      <ol className="setup-steps">
        <li>
          The account must be a Professional account (Creator or Business). Switch for free in the Instagram app: Settings
          → Account type and tools.
        </li>
        <li>
          In{' '}
          <a href="https://developers.facebook.com/apps/" target="_blank" rel="noreferrer">
            Meta for Developers
          </a>{' '}
          open your app → App roles → Roles → Add People → <strong>Instagram Tester</strong> → type its username.
        </li>
        <li>
          Logged in as that account, accept the invite:{' '}
          <a href="https://www.instagram.com/accounts/manage_access/" target="_blank" rel="noreferrer">
            instagram.com → Apps and websites → Tester invites
          </a>
          .
        </li>
        <li>
          Click <strong>+ Add another</strong> here and log in with that account (or use <strong>Send link</strong> and open
          it where that account is logged in, e.g. on a phone).
        </li>
      </ol>
    </div>
  );
}

export function AccountsPage({ postizUrl, toast }: { postizUrl: string; toast: (msg: string) => void }) {
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [platforms, setPlatforms] = useState<Platform[]>([]);
  const [networks, setNetworks] = useState<NetworksInfo | null>(null);
  const [prefs, setPrefs] = useState<Preferences | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState<string | null>(null);
  const [showBluesky, setShowBluesky] = useState(false);
  const [openSetup, setOpenSetup] = useState<string | null>(null);
  const [showIgHelp, setShowIgHelp] = useState(false);
  const [shareLink, setShareLink] = useState<{ platform: string; url: string } | null>(null);
  const [applyNotice, setApplyNotice] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    try {
      setAccounts(await api.accounts());
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  const loadPlatforms = useCallback(async () => {
    try {
      const [list, info] = await Promise.all([api.platforms(), api.networks()]);
      setPlatforms([...list].sort((a, b) => Number(b.configured) - Number(a.configured)));
      setNetworks(info);
      return info;
    } catch {
      return null; // the dashboard restarts while new keys are applied
    }
  }, []);

  useEffect(() => {
    refresh();
    loadPlatforms();
    api.preferences().then(setPrefs).catch(() => {});
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [refresh, loadPlatforms]);

  // While saved keys are being applied, keep checking until they're live.
  const helperOn = networks?.autoApply ?? true;
  const applying = !!(networks?.pending || networks?.apply?.state === 'running' || applyNotice);
  useEffect(() => {
    if (!applying || !helperOn) return;
    const handle = setInterval(async () => {
      const info = await loadPlatforms();
      if (info && !info.pending && info.apply?.state !== 'running' && applyNotice) {
        setApplyNotice(null);
        if (info.apply?.state === 'failed') toast(`Couldn't apply the keys: ${info.apply.message}`);
        else toast('New keys are live');
      }
    }, 5000);
    return () => clearInterval(handle);
  }, [applying, helperOn, applyNotice, loadPlatforms, toast]);

  async function connect(platform: Platform, another = false) {
    // Open the window right away (inside the click) so pop-up blockers allow it.
    const popup = window.open('about:blank', 'fifofarm-connect', 'width=640,height=780');
    setConnecting(platform.identifier);
    setError(null);
    let url: string;
    try {
      url = (await api.connectUrl(platform.identifier, another)).url;
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

  async function sendLink(platform: Platform) {
    setError(null);
    try {
      const { url } = await api.connectLink(platform.identifier);
      setShareLink({ platform: platform.name, url });
      if (await copyText(url)) toast('Link copied — valid for 1 hour');
      // Keep checking for the new account for a while.
      const before = new Set((accounts ?? []).map((a) => a.id));
      const started = Date.now();
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = setInterval(async () => {
        const list = await api.accounts().catch(() => null);
        if (!list) return;
        const added = list.filter((a) => !before.has(a.id));
        if (added.length > 0 || Date.now() - started > 60 * 60 * 1000) {
          setAccounts(list);
          if (added.length > 0) toast(`Connected ${added.map((a) => a.name).join(', ')}`);
          clearInterval(pollRef.current!);
          pollRef.current = null;
        }
      }, 5000);
    } catch (err) {
      setError((err as Error).message);
    }
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

  const setupFor = (identifier: string) => networks?.setups.find((s) => s.platforms.includes(identifier)) ?? null;
  const platformFor = (identifier: string) => platforms.find((p) => p.identifier === identifier) ?? null;

  // Connected accounts grouped per network, in a stable order.
  const groups = new Map<string, Account[]>();
  for (const a of accounts ?? []) groups.set(a.identifier, [...(groups.get(a.identifier) ?? []), a]);

  return (
    <div>
      {applying && helperOn && (
        <div className="notice info" style={{ marginBottom: 16 }}>
          {applyNotice ?? 'Applying new keys…'} Accounts that are already connected keep working; scheduled posts wait
          safely until the posting engine is back.
        </div>
      )}
      {networks?.pending && !helperOn && (
        <div className="notice warn" style={{ marginBottom: 16 }}>
          Keys saved. They're applied as soon as automatic updates are switched on for this server.
        </div>
      )}

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
        {shareLink && (
          <div className="notice info stack" style={{ marginBottom: 10 }}>
            <span>
              Send this link to whoever owns the {shareLink.platform} account, or open it on a phone where that account is
              logged in. After they approve, the account appears here. Valid for 1 hour.
            </span>
            <CopyField value={shareLink.url} />
            <button className="btn link small" onClick={() => setShareLink(null)}>
              Hide
            </button>
          </div>
        )}
        {accounts === null ? (
          <p className="muted">Loading…</p>
        ) : accounts.length === 0 ? (
          <p className="muted">Nothing connected yet — pick a network below.</p>
        ) : (
          <div className="stack">
            {[...groups.entries()].map(([identifier, list]) => {
              const platform = platformFor(identifier);
              const canAdd = platform && platform.connect === 'oauth' && platform.configured;
              return (
                <div key={identifier} className="account-group">
                  <div className="account-group-head">
                    <PlatformBadge identifier={identifier} />
                    <strong>{list[0].platform}</strong>
                    <span className="muted small">
                      {list.length} account{list.length === 1 ? '' : 's'}
                    </span>
                    <span className="spacer" />
                    {canAdd && (
                      <>
                        <button className="btn small primary" disabled={connecting !== null} onClick={() => connect(platform, true)}>
                          {connecting === identifier ? 'Waiting…' : '+ Add another'}
                        </button>
                        <button className="btn small" onClick={() => sendLink(platform)}>
                          Send link
                        </button>
                      </>
                    )}
                    {platform?.connect === 'credentials' && (
                      <button className="btn small primary" onClick={() => setShowBluesky(true)}>
                        + Add another
                      </button>
                    )}
                    {identifier === 'instagram-standalone' && (
                      <button className="btn link small" onClick={() => setShowIgHelp((v) => !v)}>
                        {showIgHelp ? 'Hide help' : 'How?'}
                      </button>
                    )}
                  </div>
                  {identifier === 'instagram-standalone' && showIgHelp && <InstagramExtraHelp />}
                  <div className="account-list">
                    {list.map((a) => (
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
                          {a.identifier === 'pinterest' && prefs && (
                            <PinterestBoardPicker account={a} prefs={prefs} onSaved={setPrefs} />
                          )}
                        </div>
                        <button className="btn danger small" onClick={() => remove(a)}>
                          Disconnect
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <section className="card">
        <h2>Add a network</h2>
        <p className="muted small">
          <strong>Connect</strong> opens the network's sign-in window; approve there and the account shows up above. Networks
          marked <strong>Set up</strong> need a one-time developer app first — Fifofarm walks you through it.
        </p>
        {connecting && (
          <div className="notice info" style={{ marginBottom: 10 }}>
            Waiting for you to finish in the sign-in window… (close it to cancel)
          </div>
        )}
        {showBluesky && (
          <div className="card" style={{ marginBottom: 12 }}>
            <BlueskyForm
              onConnected={() => {
                toast('Connected Bluesky');
                setShowBluesky(false);
                refresh();
              }}
            />
          </div>
        )}
        <div className="platform-grid">
          {platforms.map((p) => {
            const setup = setupFor(p.identifier);
            const count = groups.get(p.identifier)?.length ?? 0;
            return (
              <div className={`platform-tile${openSetup === p.identifier ? ' wide' : ''}`} key={p.identifier}>
                <div className="row">
                  <PlatformBadge identifier={p.identifier} />
                  <strong>{p.name}</strong>
                  {count > 0 && <span className="chip published">{count} connected</span>}
                </div>
                {p.connect === 'credentials' ? (
                  <button className="btn small" onClick={() => setShowBluesky(true)}>
                    Connect
                  </button>
                ) : p.configured ? (
                  <div className="row">
                    <button className="btn small primary" disabled={connecting !== null} onClick={() => connect(p, count > 0)}>
                      {connecting === p.identifier ? 'Connecting…' : count > 0 ? '+ Add another' : 'Connect'}
                    </button>
                    <button className="btn small" onClick={() => sendLink(p)}>
                      Send link
                    </button>
                    {setup && (
                      <button
                        className="btn link small"
                        onClick={() => setOpenSetup(openSetup === p.identifier ? null : p.identifier)}
                      >
                        {openSetup === p.identifier ? 'Hide setup' : 'Setup'}
                      </button>
                    )}
                  </div>
                ) : setup ? (
                  <button className="btn small" onClick={() => setOpenSetup(openSetup === p.identifier ? null : p.identifier)}>
                    {openSetup === p.identifier ? 'Hide' : 'Set up'}
                  </button>
                ) : (
                  <div className="muted small">Needs developer keys first.</div>
                )}
                {setup && openSetup === p.identifier && networks && (
                  <NetworkSetupPanel
                    setup={setup}
                    verificationFiles={networks.verificationFiles}
                    autoApply={networks.autoApply}
                    onVerificationChange={(files) => setNetworks((n) => (n ? { ...n, verificationFiles: files } : n))}
                    onSaved={(message) => {
                      setApplyNotice(message);
                      setOpenSetup(null);
                      loadPlatforms();
                    }}
                  />
                )}
              </div>
            );
          })}
        </div>
        <p className="muted small" style={{ marginTop: 12 }}>
          Other networks (Reddit, Discord, Telegram, Google Business…) can be connected in the{' '}
          <a href={`${postizUrl}/launches`} target="_blank" rel="noreferrer">
            posting engine (Postiz)
          </a>
          .
        </p>
      </section>
    </div>
  );
}
