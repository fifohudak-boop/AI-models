import { useCallback, useEffect, useState } from 'react';
import type { Account, AppStatus, FolderKind, Model, ModelStudioKey, ProviderKeyInfo, ProviderMeta, Person, Preferences } from '../types';
import { api } from '../api';
import { AccountAvatar } from '../components/AccountAvatar';
import { EngineSetup } from '../components/EngineSetup';
import { ModelAvatar } from '../components/ModelSwitcher';
import { FOLDER_HINTS, FOLDER_LABELS } from '../folders';

const COLORS = ['#4f46e5', '#db2777', '#059669', '#d97706', '#0891b2', '#7c3aed', '#dc2626', '#65a30d'];
const FOLDER_ORDER: FolderKind[] = ['references', 'photos', 'found', 'generated', 'edited'];
const DEFAULT_FOLDERS: FolderKind[] = ['found', 'generated', 'edited'];

function FolderRow({
  model,
  kind,
  onSaved,
  toast,
}: {
  model: Model;
  kind: FolderKind;
  onSaved: (m: Model) => void;
  toast: (m: string) => void;
}) {
  const path = model.folders[kind];
  const [busy, setBusy] = useState(false);
  async function save(next: string) {
    setBusy(true);
    try {
      onSaved(await api.updateModel(model.id, { folders: { [kind]: next } }));
    } catch (err) {
      toast((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="folder-row">
      <div className="folder-main">
        <div className="folder-label">
          <strong className="small">{FOLDER_LABELS[kind]}</strong>{' '}
          <span className="muted small">{FOLDER_HINTS[kind]}</span>
        </div>
        <div className={`small mono folder-path${path ? '' : ' muted'}`}>{path || 'Not connected'}</div>
      </div>
      <div className="row folder-actions">
        <button
          type="button"
          className="btn small"
          disabled={busy}
          onClick={async () => {
            try {
              const { path: chosen } = await api.pickFolder(path, `${FOLDER_LABELS[kind]} for ${model.name}`);
              if (chosen) await save(chosen);
            } catch (err) {
              toast((err as Error).message);
            }
          }}
        >
          {path ? 'Change…' : 'Connect folder…'}
        </button>
        {path && (
          <button type="button" className="btn link small" onClick={() => api.openFolder(path).catch((e) => toast(e.message))}>
            Open
          </button>
        )}
        {path && !DEFAULT_FOLDERS.includes(kind) && (
          <button type="button" className="btn link small" disabled={busy} onClick={() => save('')}>
            Disconnect
          </button>
        )}
      </div>
    </div>
  );
}

// One provider's key for a model. A model can hold a key for every provider at once, so each has its
// own connect/remove here; you then switch between them freely in AI Studio. Keys are shown masked.
function ProviderKeyRow({
  model,
  provider,
  info,
  onSaved,
  toast,
}: {
  model: Model;
  provider: ProviderMeta;
  info: ProviderKeyInfo;
  onSaved: (next: ModelStudioKey) => void;
  toast: (m: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState('');
  const [region, setRegion] = useState(info.region || provider.regions[0]?.id || 'intl');
  const [workspace, setWorkspace] = useState(info.hasKey ? info.workspace : '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const needsWorkspace = provider.needsWorkspace;
  const multiRegion = provider.regions.length > 1;
  const regionOk = provider.regions.some((r) => r.id === region);
  const canSave = Boolean(key.trim() && regionOk && (!needsWorkspace || workspace.trim()));
  const regionName = provider.regions.find((r) => r.id === info.region)?.name ?? info.region;

  const chip = info.connected
    ? { cls: 'published', text: 'connected' }
    : info.hasKey
      ? { cls: 'draft', text: needsWorkspace ? 'needs workspace' : 'key saved' }
      : info.usingDefault
        ? { cls: '', text: 'shared default' }
        : null;
  const detail = info.hasKey
    ? `${multiRegion ? `${regionName} · ` : ''}${info.keyMasked}`
    : info.usingDefault
      ? 'using the shared default Wan key'
      : 'no key yet';

  async function run(fn: () => Promise<ModelStudioKey>, done: string) {
    setBusy(true);
    setError(null);
    try {
      onSaved(await fn());
      setKey('');
      setOpen(false);
      toast(done);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="folder-row" style={{ display: 'block' }}>
      <div className="row">
        <div className="small" style={{ flex: 1 }}>
          <strong>{provider.name}</strong> <span className="muted">· {provider.kind === 'image' ? 'images' : 'video'}</span>
          {chip && <span className={`chip ${chip.cls}`} style={{ marginLeft: 6 }}>{chip.text}</span>}
          <div className="muted small mono" style={{ marginTop: 2 }}>{detail}</div>
        </div>
        <button type="button" className="btn small" onClick={() => setOpen((o) => !o)}>
          {open ? 'Close' : info.hasKey ? 'Change…' : 'Connect…'}
        </button>
      </div>
      {open && (
        <div className="stack" style={{ marginTop: 8 }}>
          <label className="field">
            <span className="small">
              API key {info.hasKey && <span className="muted small">(saved: {info.keyMasked})</span>}
            </span>
            <input
              type="password"
              autoComplete="off"
              placeholder={info.hasKey ? 'Paste a new key to replace it' : 'Paste the key for this account'}
              value={key}
              onChange={(e) => setKey(e.target.value)}
            />
          </label>
          {multiRegion && (
            <label className="field">
              <span className="small">Region</span>
              <select value={region} onChange={(e) => setRegion(e.target.value)}>
                {provider.regions.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          {needsWorkspace && (
            <label className="field">
              <span className="small">
                Workspace ID <span className="muted small">(required)</span>
              </span>
              <input
                type="text"
                autoComplete="off"
                spellCheck={false}
                placeholder="Model Studio workspace ID"
                value={workspace}
                onChange={(e) => setWorkspace(e.target.value)}
              />
            </label>
          )}
          <p className="muted small" style={{ margin: 0 }}>
            {provider.keyHint}{' '}
            {provider.console && (
              <a href={provider.console} target="_blank" rel="noreferrer">
                Open the console
              </a>
            )}
          </p>
          {error && <div className="notice error small">{error}</div>}
          <div className="row">
            <button
              type="button"
              className="btn primary small"
              disabled={busy || !canSave}
              onClick={() =>
                run(
                  () => api.saveModelStudioKey(model.id, provider.id, key.trim() ? key : null, region, workspace.trim()),
                  `${provider.name} key saved for ${model.name}`
                )
              }
            >
              {busy ? 'Checking…' : 'Save key'}
            </button>
            {info.hasKey && (
              <button
                type="button"
                className="btn link small"
                disabled={busy}
                onClick={() => run(() => api.saveModelStudioKey(model.id, provider.id, '', region, ''), `${provider.name} key removed`)}
              >
                Remove
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// Every provider's key for one model, each connected independently. Connect the ones you want once;
// in AI Studio you switch between them without re-entering anything.
function ModelStudioKeySection({ model, toast }: { model: Model; toast: (m: string) => void }) {
  const [info, setInfo] = useState<ModelStudioKey | null>(null);
  useEffect(() => {
    let active = true;
    api
      .modelStudioKey(model.id)
      .then((i) => active && setInfo(i))
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [model.id]);
  if (!info) return null;
  return (
    <div className="stack">
      <div className="small" style={{ fontWeight: 600 }}>AI Studio keys</div>
      <p className="muted small" style={{ margin: 0 }}>
        Connect a key for each provider you want to use with {model.name}. They're saved separately, so in AI Studio you
        switch between them freely — no re-entering keys. Each provider is its own account, billed on its own.
      </p>
      {info.providers.map((p) => {
        const ki = info.keys[p.id];
        return ki ? <ProviderKeyRow key={p.id} model={model} provider={p} info={ki} onSaved={setInfo} toast={toast} /> : null;
      })}
    </div>
  );
}

// A compact, read-only view of this model's posting accounts, plus a jump to the full Accounts page
// where you connect/move them. The posting engine itself is one shared connection (General settings).
function ModelPostingSection({ model, status, onManage }: { model: Model; status: AppStatus; onManage: () => void }) {
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const engineOk = status.engine.state === 'ok';
  useEffect(() => {
    setAccounts(null);
    setError(null);
    if (!engineOk) return; // nothing to list until the shared posting engine is connected (General)
    let active = true;
    api
      .accounts(model.id)
      .then((a) => active && setAccounts(a))
      .catch((e) => active && setError((e as Error).message));
    return () => {
      active = false;
    };
  }, [model.id, engineOk]);
  return (
    <div className="stack" style={{ borderTop: '1px solid var(--border)', paddingTop: 14 }}>
      <div className="row">
        <div className="small">
          <strong>Posting</strong>{' '}
          <span className="muted">{engineOk ? 'engine connected · accounts below' : 'engine not connected'}</span>
        </div>
        <span className="spacer" />
        <button type="button" className="btn small" onClick={onManage}>
          Manage accounts…
        </button>
      </div>
      {!engineOk && (
        <div className="notice warn small" style={{ margin: 0 }}>
          Connect the posting engine in <strong>General</strong> to post and to add accounts.
        </div>
      )}
      {engineOk && error && <div className="notice error small" style={{ margin: 0 }}>{error}</div>}
      {engineOk && accounts === null && !error && <p className="muted small" style={{ margin: 0 }}>Loading accounts…</p>}
      {accounts && accounts.length === 0 && (
        <p className="muted small" style={{ margin: 0 }}>
          No accounts for {model.name} yet — use <strong>Manage accounts</strong> to connect TikTok, Instagram and the rest.
        </p>
      )}
      {accounts && accounts.length > 0 && (
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
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// Everything for one model in one focused place: name & colour, its folders, its AI Studio key, and
// its posting accounts. Shown one model at a time (picked above) so the page never becomes a wall.
function ModelSettings({
  model,
  status,
  isCurrent,
  onSaved,
  onDelete,
  onSelect,
  onManageAccounts,
  toast,
}: {
  model: Model;
  status: AppStatus;
  isCurrent: boolean;
  onSaved: (m: Model) => void;
  onDelete: () => void;
  onSelect: () => void;
  onManageAccounts: () => void;
  toast: (m: string) => void;
}) {
  const [name, setName] = useState(model.name);
  const [typed, setTyped] = useState('');
  useEffect(() => setName(model.name), [model.name]);
  useEffect(() => setTyped(''), [model.id]);
  return (
    <section className="card stack">
      <div className="card-head" style={{ marginBottom: 0 }}>
        <h2 className="row" style={{ gap: 8, margin: 0, alignItems: 'center' }}>
          <ModelAvatar model={model} size={28} /> {model.name}
          {isCurrent && <span className="chip published">showing now</span>}
        </h2>
        {!isCurrent && (
          <button type="button" className="btn small" onClick={onSelect}>
            Show {model.name}
          </button>
        )}
      </div>

      <form
        className="row"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            onSaved(await api.updateModel(model.id, { name }));
            toast('Renamed');
          } catch (err) {
            toast((err as Error).message);
          }
        }}
      >
        <label className="field" style={{ flex: 1 }}>
          <span className="small">Name</span>
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <button className="btn small" disabled={!name.trim() || name.trim() === model.name} style={{ alignSelf: 'flex-end' }}>
          Rename
        </button>
      </form>
      <div>
        <div className="small" style={{ fontWeight: 600, marginBottom: 6 }}>
          Color
        </div>
        <div className="row color-row">
          {COLORS.map((c) => (
            <button
              key={c}
              type="button"
              className={`color-dot${model.color === c ? ' on' : ''}`}
              style={{ background: c }}
              aria-label={`Color ${c}`}
              aria-pressed={model.color === c}
              onClick={async () => onSaved(await api.updateModel(model.id, { color: c }))}
            />
          ))}
        </div>
      </div>

      <div className="stack" style={{ borderTop: '1px solid var(--border)', paddingTop: 14 }}>
        <div className="small" style={{ fontWeight: 600 }}>
          Folders
        </div>
        <p className="muted small" style={{ margin: 0 }}>
          Your reference videos and {model.name}'s photos are yours to choose; Reel Finder and AI Studio save into the rest.
        </p>
        {FOLDER_ORDER.map((kind) => (
          <FolderRow key={kind} model={model} kind={kind} onSaved={onSaved} toast={toast} />
        ))}
      </div>

      <div className="stack" style={{ borderTop: '1px solid var(--border)', paddingTop: 14 }}>
        <ModelStudioKeySection model={model} toast={toast} />
      </div>

      <ModelPostingSection model={model} status={status} onManage={onManageAccounts} />

      <div className="row" style={{ borderTop: '1px solid var(--border)', paddingTop: 14 }}>
        <span className="spacer" />
        <details className="danger-zone">
          <summary className="btn danger small">Remove model…</summary>
          <div className="stack" style={{ marginTop: 8 }}>
            <p className="small" style={{ margin: 0 }}>
              Removes {model.name} from Fifofarm Ultimate: its history, analytics and Reel Finder references. Its accounts
              stay connected (they become "no model") and <strong>your files and folders aren't touched</strong>. Type the
              name to confirm.
            </p>
            <input type="text" value={typed} onChange={(e) => setTyped(e.target.value)} aria-label="Type the model's name" />
            <button type="button" className="btn danger small" disabled={typed.trim() !== model.name} onClick={onDelete}>
              Remove {model.name}
            </button>
          </div>
        </details>
      </div>
    </section>
  );
}

// AI Studio keys live per model (each model → AI Studio key), so every model bills to its own account
// and the billing stays separate. There is no shared default key.
function StudioKeyCard() {
  return (
    <section className="card stack" id="studio">
      <h2>AI Studio keys are per model</h2>
      <p className="small" style={{ margin: 0 }}>
        Each model uses its <strong>own</strong> AI Studio key, so a model's videos and images always bill to that
        model's own account — the billing stays separate, with nothing shared in the background. Set a key in a model's
        own settings: pick a model above, then <em>AI Studio key</em>. Give <strong>each</strong> model its own Alibaba
        (Wan) key from a <strong>different account</strong> to keep their bills apart (ArgoLink / Nano Banana Pro can reuse
        one key across models if you like). Make keys in the{' '}
        <a href="https://modelstudio.console.alibabacloud.com/" target="_blank" rel="noreferrer">
          Model Studio console
        </a>
        ; for Wan the key, region and workspace ID must all be from the same account.
      </p>
      <p className="muted small" style={{ margin: 0 }}>
        Tip: to keep costs down, pick <strong>720p</strong> (or 480p) and a <strong>Germany (Frankfurt)</strong> key — the
        same video is roughly 4× cheaper than 1080p on Singapore — and set a short length for test runs.
      </p>
    </section>
  );
}

function PostingDefaults({ prefs, save }: { prefs: Preferences; save: (patch: Partial<Preferences>) => void }) {
  return (
    <>
      <section className="card stack">
        <h2>Captions</h2>
        <label className="check">
          <input type="checkbox" checked={prefs.autoShorten} onChange={(e) => save({ autoShorten: e.target.checked })} />
          <span>
            Shorten captions automatically when they're too long for a network (e.g. X's 280 characters)
            <span className="muted small" style={{ display: 'block' }}>
              Off = accounts with a too-long caption are skipped instead.
            </span>
          </span>
        </label>
      </section>
      <section className="card stack">
        <h2>YouTube</h2>
        <label className="field">
          <span>Video visibility</span>
          <select value={prefs.youtubeVisibility} onChange={(e) => save({ youtubeVisibility: e.target.value as Preferences['youtubeVisibility'] })}>
            <option value="public">Public</option>
            <option value="unlisted">Unlisted</option>
            <option value="private">Private</option>
          </select>
        </label>
      </section>
      <section className="card stack">
        <h2>TikTok</h2>
        <label className="field">
          <span>Who can watch</span>
          <select value={prefs.tiktokPrivacy} onChange={(e) => save({ tiktokPrivacy: e.target.value as Preferences['tiktokPrivacy'] })}>
            <option value="PUBLIC_TO_EVERYONE">Everyone</option>
            <option value="FOLLOWER_OF_CREATOR">Followers</option>
            <option value="MUTUAL_FOLLOW_FRIENDS">Friends</option>
            <option value="SELF_ONLY">Only me</option>
          </select>
        </label>
        <div className="notice warn small">
          Until TikTok approves your developer app (its "audit"), TikTok only accepts <strong>Only me</strong>, and the
          TikTok account itself must be set to private.
        </div>
        <label className="field">
          <span>How to post</span>
          <select value={prefs.tiktokMode} onChange={(e) => save({ tiktokMode: e.target.value as Preferences['tiktokMode'] })}>
            <option value="DIRECT_POST">Publish directly</option>
            <option value="UPLOAD">Send to the TikTok inbox as a draft (finish it in the app)</option>
          </select>
        </label>
        <label className="check">
          <input type="checkbox" checked={prefs.tiktokAllowComments} onChange={(e) => save({ tiktokAllowComments: e.target.checked })} />
          <span>Allow comments</span>
        </label>
        <label className="check">
          <input type="checkbox" checked={prefs.tiktokAllowDuet} onChange={(e) => save({ tiktokAllowDuet: e.target.checked })} />
          <span>Allow Duets</span>
        </label>
        <label className="check">
          <input type="checkbox" checked={prefs.tiktokAllowStitch} onChange={(e) => save({ tiktokAllowStitch: e.target.checked })} />
          <span>Allow Stitches</span>
        </label>
      </section>
      <section className="card stack">
        <h2>X (Twitter)</h2>
        <label className="field">
          <span>Who can reply</span>
          <select value={prefs.xWhoCanReply} onChange={(e) => save({ xWhoCanReply: e.target.value as Preferences['xWhoCanReply'] })}>
            <option value="everyone">Everyone</option>
            <option value="following">Accounts you follow</option>
            <option value="mentionedUsers">Only accounts you mention</option>
            <option value="verified">Verified accounts</option>
          </select>
        </label>
      </section>
    </>
  );
}


// Let other people reach this dashboard from their own computer, with a login.
function SharingCard({ status, onStatus, toast }: { status: AppStatus; onStatus: () => void; toast: (m: string) => void }) {
  const current = status.sharing ?? { enabled: false, host: '' };
  const [host, setHost] = useState(current.host);
  const [busy, setBusy] = useState(false);
  useEffect(() => setHost(current.host), [current.host]);

  async function save(enabled: boolean) {
    setBusy(true);
    try {
      await api.saveSharing(enabled, host.trim());
      onStatus();
      toast(enabled ? 'Sharing is on' : 'Sharing is off');
    } catch (err) {
      toast((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card stack" id="sharing">
      <div className="card-head" style={{ marginBottom: 0 }}>
        <h2>Sharing</h2>
        <span className={`chip ${current.enabled ? 'published' : ''}`}>{current.enabled ? 'on' : 'off'}</span>
      </div>
      <p className="small" style={{ margin: 0 }}>
        Let other people open this dashboard from their own computer and sign in. You choose which models each person
        sees; everything else (keys, models, prices, these settings) stays yours. On this Mac you're always the owner and
        never have to log in.
      </p>
      <label className="field">
        <span>Web address people will use</span>
        <input
          type="text"
          spellCheck={false}
          autoComplete="off"
          placeholder="ultimate.yourname.com"
          value={host}
          onChange={(e) => setHost(e.target.value)}
        />
      </label>
      <p className="muted small" style={{ margin: 0 }}>
        This is the address of the free tunnel that points at this Mac — set it up once (see <strong>Share it with your
        team</strong> in the README). The app itself stays on localhost; the tunnel carries it over HTTPS with the login in
        front.
      </p>
      <div className="row">
        {current.enabled ? (
          <>
            <button className="btn small" disabled={busy || !host.trim() || host.trim() === current.host} onClick={() => save(true)}>
              Save address
            </button>
            <button className="btn link small" disabled={busy} onClick={() => save(false)}>
              Turn sharing off
            </button>
          </>
        ) : (
          <button className="btn primary small" disabled={busy || !host.trim()} onClick={() => save(true)}>
            Turn sharing on
          </button>
        )}
      </div>
    </section>
  );
}

function randomPassword(): string {
  const chars = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const arr = new Uint32Array(14);
  crypto.getRandomValues(arr);
  let out = '';
  for (let i = 0; i < arr.length; i++) out += chars[arr[i] % chars.length];
  return out;
}

// One invited person: which models they can use, a password reset, and removal.
function PersonRow({ person, models, onChanged, toast }: { person: Person; models: Model[]; onChanged: () => void; toast: (m: string) => void }) {
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<string[]>(person.models);
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => setPicked(person.models), [person.models]);
  const changed = [...picked].sort().join() !== [...person.models].sort().join();

  const toggle = (id: string) => setPicked((l) => (l.includes(id) ? l.filter((x) => x !== id) : [...l, id]));

  async function run(fn: () => Promise<unknown>, done: string) {
    setBusy(true);
    try {
      await fn();
      onChanged();
      toast(done);
    } catch (err) {
      toast((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`model-card${open ? ' open' : ''}`}>
      <button type="button" className="model-card-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="account-main">
          <span className="account-name">{person.name || person.username}</span>
          <span className="account-meta">
            @{person.username} · {person.modelNames.length ? person.modelNames.join(', ') : 'no models yet'}
          </span>
        </span>
        <span className="caret" aria-hidden="true">
          {open ? '▴' : '▾'}
        </span>
      </button>
      {open && (
        <div className="stack model-card-body">
          <div>
            <div className="small" style={{ fontWeight: 600, marginBottom: 6 }}>
              Models they can use
            </div>
            <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
              {models.map((m) => (
                <label key={m.id} className="check">
                  <input type="checkbox" checked={picked.includes(m.id)} onChange={() => toggle(m.id)} />
                  <span>{m.name}</span>
                </label>
              ))}
            </div>
            {changed && (
              <div className="row" style={{ marginTop: 8 }}>
                <button className="btn small" disabled={busy} onClick={() => run(() => api.setPersonModels(person.id, picked), 'Saved')}>
                  Save models
                </button>
              </div>
            )}
          </div>
          <label className="field">
            <span>Reset password</span>
            <div className="row">
              <input
                type="text"
                value={pw}
                autoComplete="off"
                placeholder="new password (6+ characters)"
                onChange={(e) => setPw(e.target.value)}
                style={{ flex: 1 }}
              />
              <button type="button" className="btn small" onClick={() => setPw(randomPassword())}>
                Generate
              </button>
              <button
                type="button"
                className="btn small"
                disabled={busy || pw.length < 6}
                onClick={() => run(async () => { await api.resetPersonPassword(person.id, pw); setPw(''); }, 'Password reset')}
              >
                Set
              </button>
            </div>
          </label>
          <div className="row">
            <span className="spacer" />
            <button
              type="button"
              className="btn danger small"
              disabled={busy}
              onClick={() => run(() => api.removePerson(person.id), `Removed ${person.username}`)}
            >
              Remove {person.username}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// The owner invites people here and chooses which models each one can use.
function PeopleCard({ models, toast }: { models: Model[]; toast: (m: string) => void }) {
  const [people, setPeople] = useState<Person[] | null>(null);
  const [name, setName] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api.people().then(setPeople).catch((e) => setError((e as Error).message));
  }, []);
  useEffect(load, [load]);

  const toggle = (id: string) => setPicked((l) => (l.includes(id) ? l.filter((x) => x !== id) : [...l, id]));

  return (
    <section className="card stack" id="people">
      <h2>People</h2>
      <p className="small" style={{ margin: 0 }}>
        Invite people and choose which models each one can use. Give them the web address above, their username and their
        password, and they sign in from anywhere. On the models you give them they can do everything — post, generate, edit.
      </p>

      {people && people.length > 0 && (
        <div className="stack">
          {people.map((p) => (
            <PersonRow key={p.id} person={p} models={models} onChanged={load} toast={toast} />
          ))}
        </div>
      )}
      {people && people.length === 0 && (
        <p className="muted small" style={{ margin: 0 }}>
          No one invited yet.
        </p>
      )}

      <form
        className="stack"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            await api.addPerson({ username: username.trim(), password, name: name.trim(), models: picked });
            setName('');
            setUsername('');
            setPassword('');
            setPicked([]);
            load();
            toast(`Added ${username.trim()}`);
          } catch (err) {
            setError((err as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="small" style={{ fontWeight: 600 }}>
          Invite someone
        </div>
        <div className="row2">
          <label className="field">
            <span>Name</span>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Ben" />
          </label>
          <label className="field">
            <span>Username</span>
            <input value={username} autoComplete="off" onChange={(e) => setUsername(e.target.value)} placeholder="ben" />
          </label>
        </div>
        <label className="field">
          <span>Password</span>
          <div className="row">
            <input
              type="text"
              value={password}
              autoComplete="off"
              placeholder="at least 6 characters"
              onChange={(e) => setPassword(e.target.value)}
              style={{ flex: 1 }}
            />
            <button type="button" className="btn small" onClick={() => setPassword(randomPassword())}>
              Generate
            </button>
          </div>
        </label>
        <div>
          <div className="small" style={{ fontWeight: 600, marginBottom: 6 }}>
            Models they can use
          </div>
          {models.length === 0 ? (
            <p className="muted small" style={{ margin: 0 }}>
              Add a model first.
            </p>
          ) : (
            <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
              {models.map((m) => (
                <label key={m.id} className="check">
                  <input type="checkbox" checked={picked.includes(m.id)} onChange={() => toggle(m.id)} />
                  <span>{m.name}</span>
                </label>
              ))}
            </div>
          )}
        </div>
        {error && <div className="notice error small">{error}</div>}
        <div className="row">
          <button className="btn primary small" disabled={busy || !username.trim() || password.length < 6}>
            Add person
          </button>
        </div>
      </form>
    </section>
  );
}

// The shared, owner-only settings that aren't about one model: the posting engine, the default AI
// Studio key, posting defaults, sharing and the people invited.
function GeneralSettings({
  status,
  models,
  prefs,
  onStatus,
  reload,
  savePrefs,
  toast,
}: {
  status: AppStatus;
  models: Model[];
  prefs: Preferences | null;
  onStatus: () => void;
  reload: () => void;
  savePrefs: (patch: Partial<Preferences>) => void;
  toast: (m: string) => void;
}) {
  return (
    <>
      <EngineSetup status={status} onDone={() => { onStatus(); reload(); }} toast={toast} compact />
      {status.engine.configured && (
        <div className="row" style={{ margin: '-8px 0 16px' }}>
          <button
            type="button"
            className="btn link small"
            onClick={async () => {
              await api.disconnectEngine();
              onStatus();
              toast('Posting engine disconnected');
            }}
          >
            Disconnect the posting engine
          </button>
        </div>
      )}

      <StudioKeyCard />

      {prefs ? (
        <>
          <h2 style={{ margin: '24px 0 12px' }}>Posting defaults</h2>
          <PostingDefaults prefs={prefs} save={savePrefs} />
        </>
      ) : (
        status.engine.state !== 'ok' && (
          <p className="muted small">Posting defaults show up once the posting engine is connected.</p>
        )
      )}

      <SharingCard status={status} onStatus={onStatus} toast={toast} />
      <PeopleCard models={models} toast={toast} />

      <section className="card stack">
        <h2>About</h2>
        <p className="small" style={{ margin: 0 }}>
          {status.brand} {status.version} · build <span className="mono">{status.build}</span>
          {status.updateAvailable && <span className="chip posting" style={{ marginLeft: 8 }}>update ready — reopen the app</span>}
        </p>
        <p className="muted small" style={{ margin: 0 }}>
          Runs on this Mac only (http://127.0.0.1). Fifofarm and the Reel Finder app stay separate and unchanged; this app
          uses the same posting engine as Fifofarm, and a copy of Reel Finder's engine.
        </p>
      </section>
    </>
  );
}

export function SettingsPage({
  status,
  models,
  current,
  toast,
  onStatus,
  onModels,
  onSelectModel,
  onCreateModel,
  onGoAccounts,
}: {
  status: AppStatus;
  models: Model[];
  current: Model;
  toast: (m: string) => void;
  onStatus: () => void;
  onModels: (list: Model[]) => void;
  onSelectModel: (id: string) => void;
  onCreateModel: (name: string) => Promise<void>;
  onGoAccounts?: () => void;
}) {
  const [prefs, setPrefs] = useState<Preferences | null>(null);
  // Which panel is showing: a model's id, or 'general' for the shared owner settings.
  const [view, setView] = useState<string>(current.id);
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState('');
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    if (status.engine.state === 'ok') api.preferences().then(setPrefs).catch(() => {});
  }, [status.engine.state]);

  useEffect(load, [load]);

  async function savePrefs(patch: Partial<Preferences>) {
    setPrefs((p) => (p ? { ...p, ...patch } : p));
    try {
      setPrefs(await api.savePreferences(patch));
      toast('Saved');
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const replaceModel = (mo: Model) => onModels(models.map((x) => (x.id === mo.id ? mo : x)));
  const selected = view === 'general' ? null : models.find((mm) => mm.id === view) ?? null;

  return (
    <div>
      <h1>Settings</h1>
      {error && <div className="notice error">{error}</div>}
      <p className="small muted" style={{ margin: '0 0 12px' }}>
        Pick a model to set up just that model — its folders, its AI Studio key and its posting accounts. Shared things
        (the posting engine, sharing, the people you invite) live under <strong>General</strong>.
      </p>

      <div className="row settings-picker" style={{ flexWrap: 'wrap', gap: 8, marginBottom: 16, alignItems: 'center' }}>
        {models.map((mo) => (
          <button
            key={mo.id}
            type="button"
            className={`btn small${view === mo.id ? ' primary' : ''}`}
            onClick={() => setView(mo.id)}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
          >
            <ModelAvatar model={mo} size={18} /> {mo.name}
          </button>
        ))}
        {adding ? (
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                await onCreateModel(newName);
                setNewName('');
                setAdding(false);
              } catch (err) {
                toast((err as Error).message);
              }
            }}
            style={{ display: 'inline-flex', gap: 6 }}
          >
            <input
              autoFocus
              type="text"
              placeholder="New model's name"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              aria-label="New model's name"
            />
            <button className="btn small" disabled={!newName.trim()}>
              Add
            </button>
            <button type="button" className="btn link small" onClick={() => { setAdding(false); setNewName(''); }}>
              Cancel
            </button>
          </form>
        ) : (
          <button type="button" className="btn small" onClick={() => setAdding(true)}>
            + Add model
          </button>
        )}
        <span className="spacer" />
        <button
          type="button"
          className={`btn small${view === 'general' ? ' primary' : ''}`}
          onClick={() => setView('general')}
        >
          General
        </button>
      </div>

      {selected ? (
        <ModelSettings
          key={selected.id}
          model={selected}
          status={status}
          isCurrent={selected.id === current.id}
          onSaved={replaceModel}
          onSelect={() => onSelectModel(selected.id)}
          onManageAccounts={() => {
            onSelectModel(selected.id);
            onGoAccounts?.();
          }}
          toast={toast}
          onDelete={async () => {
            try {
              await api.deleteModel(selected.id);
              const remaining = models.filter((x) => x.id !== selected.id);
              onModels(remaining);
              setView(remaining[0]?.id ?? 'general');
              toast(`Removed ${selected.name}`);
            } catch (err) {
              toast((err as Error).message);
            }
          }}
        />
      ) : (
        <GeneralSettings
          status={status}
          models={models}
          prefs={prefs}
          onStatus={onStatus}
          reload={load}
          savePrefs={savePrefs}
          toast={toast}
        />
      )}
    </div>
  );
}
