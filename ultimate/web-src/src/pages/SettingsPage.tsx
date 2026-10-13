import { useCallback, useEffect, useState } from 'react';
import type { AppSettings, AppStatus, FolderKind, Model, Preferences } from '../types';
import { api } from '../api';
import { EngineSetup } from '../components/EngineSetup';
import { ModelAvatar } from '../components/ModelSwitcher';
import { FOLDER_HINTS, FOLDER_LABELS } from '../folders';

const COLORS = ['#4f46e5', '#db2777', '#059669', '#d97706', '#0891b2', '#7c3aed', '#dc2626', '#65a30d'];
const FOLDER_ORDER: FolderKind[] = ['references', 'photos', 'found', 'generated'];
const DEFAULT_FOLDERS: FolderKind[] = ['found', 'generated'];

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

function ModelCard({
  model,
  open,
  isCurrent,
  onToggle,
  onSaved,
  onDelete,
  onSelect,
  toast,
}: {
  model: Model;
  open: boolean;
  isCurrent: boolean;
  onToggle: () => void;
  onSaved: (m: Model) => void;
  onDelete: () => void;
  onSelect: () => void;
  toast: (m: string) => void;
}) {
  const [name, setName] = useState(model.name);
  const [typed, setTyped] = useState('');
  useEffect(() => setName(model.name), [model.name]);
  return (
    <div className={`model-card${open ? ' open' : ''}`}>
      <button type="button" className="model-card-head" onClick={onToggle} aria-expanded={open}>
        <ModelAvatar model={model} size={32} />
        <span className="account-main">
          <span className="account-name">
            {model.name} {isCurrent && <span className="chip published">showing now</span>}
          </span>
          <span className="account-meta">
            {FOLDER_ORDER.filter((k) => model.folders[k]).length} of 4 folders connected
          </span>
        </span>
        <span className="caret" aria-hidden="true">
          {open ? '▴' : '▾'}
        </span>
      </button>
      {open && (
        <div className="stack model-card-body">
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
          <div className="stack">
            <div className="small" style={{ fontWeight: 600 }}>
              Folders
            </div>
            {FOLDER_ORDER.map((kind) => (
              <FolderRow key={kind} model={model} kind={kind} onSaved={onSaved} toast={toast} />
            ))}
          </div>
          <div className="row">
            {!isCurrent && (
              <button type="button" className="btn small" onClick={onSelect}>
                Show {model.name}
              </button>
            )}
            <span className="spacer" />
            <details className="danger-zone">
              <summary className="btn danger small">Remove model…</summary>
              <div className="stack" style={{ marginTop: 8 }}>
                <p className="small" style={{ margin: 0 }}>
                  Removes {model.name} from {`Fifofarm Ultimate`}: its history, analytics and Reel Finder references. Its
                  accounts stay connected (they become "no model") and <strong>your files and folders aren't touched</strong>.
                  Type the name to confirm.
                </p>
                <input type="text" value={typed} onChange={(e) => setTyped(e.target.value)} aria-label="Type the model's name" />
                <button type="button" className="btn danger small" disabled={typed.trim() !== model.name} onClick={onDelete}>
                  Remove {model.name}
                </button>
              </div>
            </details>
          </div>
        </div>
      )}
    </div>
  );
}

// Where your Model Studio key was made (the key, the region and the workspace must match).
const STUDIO_REGIONS: { id: string; name: string; needsWorkspace: boolean }[] = [
  { id: 'intl', name: 'Singapore (international)', needsWorkspace: false },
  { id: 'cn', name: 'China (Beijing)', needsWorkspace: false },
  { id: 'us', name: 'US (Virginia)', needsWorkspace: true },
  { id: 'eu', name: 'Germany (Frankfurt)', needsWorkspace: true },
  { id: 'jp', name: 'Japan (Tokyo)', needsWorkspace: true },
  { id: 'hk', name: 'China (Hong Kong)', needsWorkspace: true },
];

function StudioKeyCard({ settings, onSaved, toast }: { settings: AppSettings; onSaved: (s: AppSettings) => void; toast: (m: string) => void }) {
  const [key, setKey] = useState('');
  const [region, setRegion] = useState(settings.alibabaRegion || 'intl');
  const [workspace, setWorkspace] = useState(settings.alibabaWorkspace || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const needsWorkspace = STUDIO_REGIONS.find((r) => r.id === region)?.needsWorkspace ?? false;
  const changedPlace = region !== (settings.alibabaRegion || 'intl') || workspace.trim() !== (settings.alibabaWorkspace || '');
  const canSave = (key.trim() || (settings.alibabaKey && changedPlace)) && (!needsWorkspace || workspace.trim());
  return (
    <section className="card stack" id="studio">
      <div className="card-head" style={{ marginBottom: 0 }}>
        <h2>AI Studio (Wan 3.0 by Alibaba)</h2>
        <span className={`chip ${settings.alibabaKey ? 'published' : ''}`}>{settings.alibabaKey ? 'key saved' : 'no key yet'}</span>
      </div>
      <p className="small" style={{ margin: 0 }}>
        AI Studio uses Alibaba Cloud <strong>Model Studio</strong> (the Wan 3.0 video models). Make an API key in the{' '}
        <a href="https://modelstudio.console.alibabacloud.com/" target="_blank" rel="noreferrer">
          Model Studio console
        </a>{' '}
        and paste it here. The key, the region and the workspace must all be the same place.
      </p>
      <form
        className="stack"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            onSaved(await api.saveStudioKey(key.trim() ? key : null, region, workspace.trim()));
            setKey('');
            toast(key.trim() ? 'Alibaba key saved' : 'Saved');
          } catch (err) {
            setError((err as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="row2">
          <label className="field">
            <span>API key {settings.alibabaKey && <span className="muted small">(saved: {settings.alibabaKey})</span>}</span>
            <input
              type="password"
              autoComplete="off"
              placeholder={settings.alibabaKey ? 'Paste a new key to replace it' : 'sk-…'}
              value={key}
              onChange={(e) => setKey(e.target.value)}
            />
          </label>
          <label className="field">
            <span>Region</span>
            <select value={region} onChange={(e) => setRegion(e.target.value)}>
              {STUDIO_REGIONS.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className="field">
          <span>
            Workspace ID{' '}
            <span className="muted small">{needsWorkspace ? '(needed for this region)' : '(optional for Singapore and Beijing)'}</span>
          </span>
          <input
            type="text"
            autoComplete="off"
            spellCheck={false}
            placeholder="Your Model Studio workspace ID"
            value={workspace}
            onChange={(e) => setWorkspace(e.target.value)}
          />
        </label>
        <p className="muted small" style={{ margin: 0 }}>
          Where to find it:{' '}
          <a href="https://help.aliyun.com/en/model-studio/obtain-the-app-id-and-workspace-id" target="_blank" rel="noreferrer">
            Alibaba's guide
          </a>
          . With it, AI Studio uses your workspace's own address, which Wan 3.0 is documented with.
        </p>
        {error && <div className="notice error small">{error}</div>}
        <div className="row">
          <button className="btn primary small" disabled={busy || !canSave}>
            {busy ? 'Checking…' : key.trim() ? 'Save key' : 'Save'}
          </button>
          {settings.alibabaKey && (
            <button
              type="button"
              className="btn link small"
              onClick={async () => {
                onSaved(await api.saveStudioKey('', region, workspace.trim()));
                toast('Alibaba key removed');
              }}
            >
              Remove key
            </button>
          )}
        </div>
      </form>
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

export function SettingsPage({
  status,
  models,
  current,
  toast,
  onStatus,
  onModels,
  onSelectModel,
  onCreateModel,
}: {
  status: AppStatus;
  models: Model[];
  current: Model;
  toast: (m: string) => void;
  onStatus: () => void;
  onModels: (list: Model[]) => void;
  onSelectModel: (id: string) => void;
  onCreateModel: (name: string) => Promise<void>;
}) {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [prefs, setPrefs] = useState<Preferences | null>(null);
  const [open, setOpen] = useState<string | null>(current.id);
  const [newName, setNewName] = useState('');
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api.settings().then(setSettings).catch((err) => setError(err.message));
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

  const replaceModel = (m: Model) => onModels(models.map((x) => (x.id === m.id ? m : x)));

  return (
    <div>
      <h1>Settings</h1>
      {error && <div className="notice error">{error}</div>}

      <section className="card stack" id="models">
        <div className="card-head" style={{ marginBottom: 0 }}>
          <h2>Models</h2>
          <span className="muted small">
            {models.length} model{models.length === 1 ? '' : 's'}
          </span>
        </div>
        <p className="small muted" style={{ margin: 0 }}>
          Every model has its own Fifofarm accounts, Reel Finder and AI Studio. Connect each model's folders here: your
          reference videos and the model's photos are yours to choose; Reel Finder and AI Studio save into the other two.
        </p>
        <div className="stack">
          {models.map((m) => (
            <ModelCard
              key={m.id}
              model={m}
              open={open === m.id}
              isCurrent={m.id === current.id}
              onToggle={() => setOpen(open === m.id ? null : m.id)}
              onSaved={replaceModel}
              onSelect={() => onSelectModel(m.id)}
              toast={toast}
              onDelete={async () => {
                try {
                  await api.deleteModel(m.id);
                  onModels(models.filter((x) => x.id !== m.id));
                  toast(`Removed ${m.name}`);
                } catch (err) {
                  toast((err as Error).message);
                }
              }}
            />
          ))}
        </div>
        <form
          className="row"
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              await onCreateModel(newName);
              setNewName('');
            } catch (err) {
              toast((err as Error).message);
            }
          }}
        >
          <input type="text" placeholder="New model's name" value={newName} onChange={(e) => setNewName(e.target.value)} style={{ flex: 1 }} aria-label="New model's name" />
          <button className="btn small" disabled={!newName.trim()}>
            + Add model
          </button>
        </form>
      </section>

      <EngineSetup status={status} onDone={() => { onStatus(); load(); }} toast={toast} compact />
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

      {settings && <StudioKeyCard settings={settings} onSaved={(s) => { setSettings(s); onStatus(); }} toast={toast} />}

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
    </div>
  );
}
