import { useCallback, useEffect, useRef, useState } from 'react';
import type { LabeledAccount, Model, Platform, Preferences } from '../types';
import { api } from '../api';
import { AccountAvatar, PlatformBadge } from '../components/AccountAvatar';
import { CopyField } from '../components/CopyField';
import { ModelAvatar } from '../components/ModelSwitcher';
import { copyText } from '../clipboard';

// After signing in, these networks ask you to pick a page/channel inside the
// sign-in window, so we must not close it automatically.
const PICKS_INSIDE_POPUP = new Set(['youtube', 'instagram', 'facebook', 'linkedin-page']);

function PinterestBoardPicker({ account, prefs, onSaved }: { account: LabeledAccount; prefs: Preferences; onSaved: (p: Preferences) => void }) {
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

function BlueskyForm({ model, onConnected }: { model: Model; onConnected: () => void }) {
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
          await api.connectBluesky(model.id, handle, password);
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
        {busy ? 'Connecting…' : `Connect Bluesky for ${model.name}`}
      </button>
    </form>
  );
}

// Meta's rule while your app hasn't passed App Review: every Instagram account must be a tester.
function InstagramHelp({ first }: { first: boolean }) {
  return (
    <div className="notice info small stack">
      <strong>{first ? 'Connecting an Instagram account' : 'Adding another Instagram account'}</strong>
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
          Click <strong>{first ? 'Connect' : '+ Add another'}</strong> here and log in with that account (or use{' '}
          <strong>Send link</strong> and open it where that account is logged in, e.g. on a phone).
        </li>
      </ol>
    </div>
  );
}

// Fifofarm's Accounts page, for one model: its accounts, connecting new ones for it, and moving
// accounts that are already in the posting engine (e.g. connected in Fifofarm) to it.
export function AccountsPage({ model, models, toast }: { model: Model; models: Model[]; toast: (msg: string) => void }) {
  const [all, setAll] = useState<LabeledAccount[] | null>(null);
  const [platforms, setPlatforms] = useState<Platform[]>([]);
  const [prefs, setPrefs] = useState<Preferences | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState<string | null>(null);
  const [showBluesky, setShowBluesky] = useState(false);
  const [igHelp, setIgHelp] = useState(false);
  const [shareLink, setShareLink] = useState<{ platform: string; url: string } | null>(null);
  const [showOthers, setShowOthers] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    try {
      setAll(await api.allAccounts());
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    refresh();
    api.platforms().then(setPlatforms).catch(() => {});
    api.preferences().then(setPrefs).catch(() => {});
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [refresh]);

  const mine = (all ?? []).filter((a) => a.modelId === model.id);
  // Accounts not in any model first — those are the ones you most likely want to add.
  const others = (all ?? [])
    .filter((a) => a.modelId !== model.id)
    .sort((a, b) => Number(Boolean(a.modelId)) - Number(Boolean(b.modelId)));
  const unassigned = others.filter((a) => !a.modelId);

  // Wait for the new account to show up (it becomes this model's automatically).
  function watchForNew(before: Set<string>, popup: Window | null, identifier: string, limitMs: number) {
    const started = Date.now();
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      const list = await api.allAccounts().catch(() => null);
      if (!list) return;
      const added = list.filter((a) => !before.has(a.id));
      const popupGone = popup ? popup.closed : false;
      if (added.length > 0 || popupGone || Date.now() - started > limitMs) {
        setAll(list);
        if (added.length > 0) {
          const ours = added.filter((a) => a.modelId === model.id);
          toast(ours.length ? `Connected ${ours.map((a) => a.name).join(', ')} for ${model.name}` : `Connected ${added.map((a) => a.name).join(', ')}`);
          if (popup && !PICKS_INSIDE_POPUP.has(identifier)) popup.close();
        }
        if (popupGone || added.length > 0 || Date.now() - started > limitMs) {
          clearInterval(pollRef.current!);
          pollRef.current = null;
          setConnecting(null);
        }
      }
    }, 2000);
  }

  async function connect(platform: Platform, another = false) {
    // Open the window right away (inside the click) so pop-up blockers allow it.
    const popup = window.open('about:blank', 'ultimate-connect', 'width=640,height=780');
    setConnecting(platform.identifier);
    setError(null);
    let url: string;
    try {
      url = (await api.connectUrl(model.id, platform.identifier, another)).url;
    } catch (err) {
      popup?.close();
      setConnecting(null);
      setError((err as Error).message);
      return;
    }
    if (popup) popup.location.href = url;
    else window.open(url, '_blank');
    watchForNew(new Set((all ?? []).map((a) => a.id)), popup, platform.identifier, 10 * 60 * 1000);
  }

  async function sendLink(platform: Platform) {
    setError(null);
    try {
      const { url } = await api.connectLink(model.id, platform.identifier);
      setShareLink({ platform: platform.name, url });
      if (await copyText(url)) toast('Link copied — valid for 1 hour');
      watchForNew(new Set((all ?? []).map((a) => a.id)), null, platform.identifier, 60 * 60 * 1000);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function move(account: LabeledAccount, modelId: string | null) {
    try {
      setAll(await api.moveAccount(account.id, modelId));
      const target = models.find((x) => x.id === modelId);
      toast(target ? `${account.name} is now ${target.name}'s` : `${account.name} removed from ${model.name}`);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const platformFor = (identifier: string) => platforms.find((p) => p.identifier === identifier) ?? null;
  const groups = new Map<string, LabeledAccount[]>();
  for (const a of mine) groups.set(a.identifier, [...(groups.get(a.identifier) ?? []), a]);

  return (
    <div>
      <section className="card">
        <div className="card-head">
          <h2 className="row" style={{ gap: 8 }}>
            <ModelAvatar model={model} size={24} /> {model.name}'s accounts
          </h2>
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
              logged in. After they approve, the account is added to <strong>{model.name}</strong>. Valid for 1 hour.
            </span>
            <CopyField value={shareLink.url} />
            <button className="btn link small" onClick={() => setShareLink(null)}>
              Hide
            </button>
          </div>
        )}
        {all === null ? (
          <p className="muted">Loading…</p>
        ) : mine.length === 0 ? (
          <p className="muted">
            {model.name} has no accounts yet. Connect one below
            {others.length > 0
              ? `, or add one that's already in your posting engine (${others.length} below${
                  unassigned.length > 0 && unassigned.length < others.length ? `, ${unassigned.length} not in a model yet` : ''
                })`
              : ''}
            .
          </p>
        ) : (
          <div className="stack">
            {[...groups.entries()].map(([identifier, list]) => {
              const platform = platformFor(identifier);
              const canAdd = platform && platform.connect === 'oauth';
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
                    {identifier === 'instagram-standalone' && (
                      <button className="btn link small" onClick={() => setIgHelp((v) => !v)}>
                        {igHelp ? 'Hide help' : 'How?'}
                      </button>
                    )}
                  </div>
                  {identifier === 'instagram-standalone' && igHelp && <InstagramHelp first={false} />}
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
                        <MoveSelect account={a} models={models} current={model} onMove={move} />
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
        <h2>Add an account for {model.name}</h2>
        <p className="muted small">
          <strong>Connect</strong> opens the network's sign-in window; approve there and the account becomes {model.name}'s.
          A network needs its one-time setup in Fifofarm first (Fifofarm → Accounts → Set up) — Ultimate uses the same
          posting engine.
        </p>
        {connecting && (
          <div className="notice info" style={{ marginBottom: 10 }}>
            Waiting for you to finish in the sign-in window… (close it to cancel)
          </div>
        )}
        {showBluesky && (
          <div className="card" style={{ marginBottom: 12 }}>
            <BlueskyForm
              model={model}
              onConnected={() => {
                toast(`Connected Bluesky for ${model.name}`);
                setShowBluesky(false);
                refresh();
              }}
            />
          </div>
        )}
        <div className="platform-grid">
          {platforms.map((p) => {
            const count = groups.get(p.identifier)?.length ?? 0;
            const ig = p.identifier === 'instagram-standalone';
            return (
              <div className={`platform-tile${ig && igHelp ? ' wide' : ''}`} key={p.identifier}>
                <div className="row">
                  <span className="tile-name">
                    <PlatformBadge identifier={p.identifier} />
                    <strong>{p.name}</strong>
                  </span>
                  {count > 0 && <span className="chip published">{count} connected</span>}
                </div>
                {p.connect === 'credentials' ? (
                  <button className="btn small" onClick={() => setShowBluesky(true)}>
                    Connect
                  </button>
                ) : (
                  <div className="row">
                    <button className="btn small primary" disabled={connecting !== null} onClick={() => connect(p, count > 0)}>
                      {connecting === p.identifier ? 'Connecting…' : count > 0 ? '+ Add another' : 'Connect'}
                    </button>
                    <button className="btn small" onClick={() => sendLink(p)}>
                      Send link
                    </button>
                    {ig && (
                      <button className="btn link small" aria-expanded={igHelp} onClick={() => setIgHelp((v) => !v)}>
                        {igHelp ? 'Hide help' : 'How?'}
                      </button>
                    )}
                  </div>
                )}
                {ig && igHelp && <InstagramHelp first={count === 0} />}
              </div>
            );
          })}
        </div>
      </section>

      <section className="card">
        <div className="card-head">
          <h2>Other accounts in your posting engine</h2>
          <button className="btn link small" onClick={() => setShowOthers((v) => !v)}>
            {showOthers ? 'Hide' : `Show ${others.length}`}
          </button>
        </div>
        <p className="muted small">
          Accounts connected in Fifofarm or for other models. Add one to {model.name} and it moves here (an account belongs to
          one model). Nothing changes in Fifofarm.
        </p>
        {showOthers &&
          (others.length === 0 ? (
            <p className="muted small">No other accounts.</p>
          ) : (
            <div className="account-list">
              {others.map((a) => (
                <div className="account" key={a.id}>
                  <AccountAvatar name={a.name} picture={a.picture} identifier={a.identifier} />
                  <div className="account-main">
                    <div className="account-name">{a.name}</div>
                    <div className="account-meta">
                      {a.platform}
                      {a.profile && ` · @${a.profile}`}
                      {a.modelName ? ` · ${a.modelName}'s` : ' · not in a model yet'}
                    </div>
                  </div>
                  <button className="btn small" onClick={() => move(a, model.id)}>
                    Add to {model.name}
                  </button>
                </div>
              ))}
            </div>
          ))}
      </section>
    </div>
  );
}

function MoveSelect({
  account,
  models,
  current,
  onMove,
}: {
  account: LabeledAccount;
  models: Model[];
  current: Model;
  onMove: (a: LabeledAccount, modelId: string | null) => void;
}) {
  return (
    <label className="owner-picker small">
      <span className="muted">Model</span>
      <select
        value={current.id}
        onChange={(e) => onMove(account, e.target.value === '-' ? null : e.target.value)}
        aria-label={`Model for ${account.name}`}
      >
        {models.map((x) => (
          <option key={x.id} value={x.id}>
            {x.name}
          </option>
        ))}
        <option value="-">No model (remove)</option>
      </select>
    </label>
  );
}
