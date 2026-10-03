import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Account, AccountPreview, Batch, MediaJob } from '../types';
import { api, uploadMedia } from '../api';
import { AccountAvatar } from '../components/AccountAvatar';
import { BatchCard } from '../components/BatchCard';
import { isActive } from '../batchStatus';
import { formatBytes, formatDuration, toLocalInputValue } from '../format';

const DRAFT_KEY = 'autopost.draft';
const SELECTION_KEY = 'autopost.unselected';
const TITLE_PLATFORMS = new Set(['youtube', 'pinterest', 'facebook']);

type MediaState =
  | { phase: 'empty' }
  | { phase: 'uploading'; name: string; fraction: number }
  | { phase: 'processing'; job: MediaJob }
  | { phase: 'ready'; job: MediaJob }
  | { phase: 'failed'; name: string; error: string };

function readStorage<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeStorage(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // storage unavailable (private mode); drafts just won't persist
  }
}

export function ComposePage({ onGoAccounts }: { onGoAccounts: () => void }) {
  const draft = readStorage(DRAFT_KEY, { caption: '', title: '' });
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Remember who you *unticked*, so newly connected accounts start ticked.
  const [unselected, setUnselected] = useState<Set<string>>(() => new Set(readStorage<string[]>(SELECTION_KEY, [])));
  const [caption, setCaption] = useState<string>(draft.caption);
  const [title, setTitle] = useState<string>(draft.title);
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [showOverrides, setShowOverrides] = useState(false);
  const [media, setMedia] = useState<MediaState>({ phase: 'empty' });
  const [dragOver, setDragOver] = useState(false);
  const [when, setWhen] = useState<'now' | 'later'>('now');
  const [scheduleAt, setScheduleAt] = useState(() => toLocalInputValue(new Date(Date.now() + 60 * 60 * 1000)));
  const [preview, setPreview] = useState<Record<string, AccountPreview>>({});
  const [posting, setPosting] = useState(false);
  const [postError, setPostError] = useState<string | null>(null);
  const [result, setResult] = useState<Batch | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api
      .accounts()
      .then(setAccounts)
      .catch((err) => setLoadError(err.message));
  }, []);

  useEffect(() => writeStorage(DRAFT_KEY, { caption, title }), [caption, title]);
  useEffect(() => writeStorage(SELECTION_KEY, [...unselected]), [unselected]);

  const mediaId = media.phase === 'ready' ? media.job.id : null;
  const mediaResult = media.phase === 'ready' ? media.job.result : null;

  // Ask the server what would happen per account (length, shortening, problems).
  useEffect(() => {
    if (!accounts?.length) return;
    const handle = setTimeout(() => {
      api
        .preview({ caption, captions: overrides, mediaId })
        .then(setPreview)
        .catch(() => {});
    }, 300);
    return () => clearTimeout(handle);
  }, [accounts, caption, overrides, mediaId]);

  const usable = useMemo(() => (accounts ?? []).filter((a) => a.supported && !a.disabled), [accounts]);
  const selected = usable.filter((a) => !unselected.has(a.id));
  const ready = selected.filter((a) => (preview[a.id]?.problems.length ?? 0) === 0);
  const skipped = selected.filter((a) => (preview[a.id]?.problems.length ?? 0) > 0);
  const needsTitle = selected.some((a) => TITLE_PLATFORMS.has(a.identifier));
  // "All Instagram", "All TikTok", ... — handy with many accounts per network.
  const networkGroups = useMemo(() => {
    const map = new Map<string, { identifier: string; name: string; ids: string[] }>();
    for (const a of usable) {
      const g = map.get(a.identifier) ?? { identifier: a.identifier, name: a.platform, ids: [] };
      g.ids.push(a.id);
      map.set(a.identifier, g);
    }
    return [...map.values()];
  }, [usable]);

  function toggle(id: string) {
    setUnselected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const pollJob = useCallback((job: MediaJob) => {
    const tick = async () => {
      try {
        const latest = await api.mediaJob(job.id);
        if (latest.status === 'ready') setMedia({ phase: 'ready', job: latest });
        else if (latest.status === 'failed') setMedia({ phase: 'failed', name: latest.name, error: latest.error ?? 'Failed' });
        else {
          setMedia({ phase: 'processing', job: latest });
          setTimeout(tick, 1000);
        }
      } catch (err) {
        setMedia({ phase: 'failed', name: job.name, error: (err as Error).message });
      }
    };
    tick();
  }, []);

  async function handleFile(file: File) {
    setResult(null);
    setMedia({ phase: 'uploading', name: file.name, fraction: 0 });
    try {
      const job = await uploadMedia(file, (fraction) => setMedia({ phase: 'uploading', name: file.name, fraction }));
      setMedia({ phase: 'processing', job });
      pollJob(job);
    } catch (err) {
      setMedia({ phase: 'failed', name: file.name, error: (err as Error).message });
    }
  }

  async function submit() {
    setPosting(true);
    setPostError(null);
    try {
      const batch = await api.post({
        caption,
        title,
        mediaId,
        accountIds: ready.map((a) => a.id),
        scheduleAt: when === 'later' ? new Date(scheduleAt).toISOString() : null,
        captions: Object.fromEntries(Object.entries(overrides).filter(([id]) => ready.some((a) => a.id === id))),
      });
      setResult(batch);
    } catch (err) {
      setPostError((err as Error).message);
    } finally {
      setPosting(false);
    }
  }

  function startOver() {
    setResult(null);
    setCaption('');
    setTitle('');
    setOverrides({});
    setMedia({ phase: 'empty' });
    setWhen('now');
  }

  // Live status of what was just posted.
  useEffect(() => {
    if (!result || !isActive(result)) return;
    const started = Date.now();
    const handle = setInterval(async () => {
      try {
        const fresh = await api.batch(result.id);
        setResult(fresh);
        if (!isActive(fresh) || Date.now() - started > 30 * 60 * 1000) clearInterval(handle);
      } catch {
        // keep trying; a blip shouldn't stop the status updates
      }
    }, 3000);
    return () => clearInterval(handle);
  }, [result?.id, result && isActive(result)]); // eslint-disable-line react-hooks/exhaustive-deps

  if (result) {
    const anyActive = isActive(result);
    return (
      <div>
        <div className="card-head">
          <h1>{anyActive ? 'Posting…' : result.scheduleAt ? 'Scheduled' : 'Done'}</h1>
          <button className="btn primary" onClick={startOver}>
            New post
          </button>
        </div>
        <p className="muted">
          {anyActive
            ? 'You can leave this page — posting continues in the background. Check History any time.'
            : 'Here is how it went on each account.'}
        </p>
        <BatchCard batch={result} onChange={setResult} onDeleted={startOver} />
      </div>
    );
  }

  const canPost =
    !posting &&
    ready.length > 0 &&
    media.phase !== 'uploading' &&
    media.phase !== 'processing' &&
    (media.phase === 'ready' || caption.trim().length > 0);

  return (
    <div>
      <section className="card">
        <h2>1. Video</h2>
        {media.phase === 'empty' || media.phase === 'failed' ? (
          <>
            <div
              className={`drop${dragOver ? ' over' : ''}`}
              role="button"
              tabIndex={0}
              onClick={() => fileInput.current?.click()}
              onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && fileInput.current?.click()}
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragOver(false);
                const file = e.dataTransfer.files[0];
                if (file) handleFile(file);
              }}
            >
              <strong>Drop a video here, or tap to choose</strong>
              <span className="muted small">MP4, MOV (iPhone), WebM… or a photo. It's converted to work everywhere.</span>
            </div>
            {media.phase === 'failed' && (
              <div className="notice error" style={{ marginTop: 10 }}>
                {media.name}: {media.error}
              </div>
            )}
          </>
        ) : media.phase === 'uploading' ? (
          <div>
            <div className="row">
              <strong>Uploading {media.name}</strong>
              <span className="muted">{Math.round(media.fraction * 100)}%</span>
            </div>
            <div className="progress">
              <div style={{ width: `${media.fraction * 100}%` }} />
            </div>
          </div>
        ) : media.phase === 'processing' ? (
          <div>
            <div className="row">
              <strong>{media.job.step}…</strong>
              <span className="muted">{media.job.progress}%</span>
            </div>
            <div className="progress">
              <div style={{ width: `${media.job.progress}%` }} />
            </div>
          </div>
        ) : (
          <div className="media-ready">
            {mediaResult?.previewUrl && <img src={mediaResult.previewUrl} alt="" />}
            <div style={{ flex: 1, minWidth: 0 }}>
              <strong style={{ wordBreak: 'break-all' }}>{media.job.name}</strong>
              <div className="muted small">
                {mediaResult?.kind === 'video'
                  ? `Video · ${formatDuration(mediaResult.durationSeconds ?? 0)} · ${mediaResult.width}×${mediaResult.height} · ${formatBytes(mediaResult.sizeBytes)}`
                  : `Photo · ${mediaResult?.width}×${mediaResult?.height}`}
                {mediaResult?.reencoded && ' · converted for all networks'}
              </div>
              <button className="btn link small" onClick={() => setMedia({ phase: 'empty' })}>
                Replace
              </button>
            </div>
          </div>
        )}
        <input
          ref={fileInput}
          type="file"
          accept="video/*,image/*"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (file) handleFile(file);
          }}
        />
      </section>

      <section className="card stack">
        <h2>2. Caption</h2>
        <textarea
          value={caption}
          onChange={(e) => setCaption(e.target.value)}
          placeholder="Write your caption and #hashtags…"
          aria-label="Caption"
        />
        {needsTitle && (
          <label className="field">
            <span>
              Title <span className="muted small">(YouTube, Pinterest, Facebook — leave empty to use the first line)</span>
            </span>
            <input type="text" value={title} maxLength={100} onChange={(e) => setTitle(e.target.value)} />
          </label>
        )}
        {selected.length > 0 && (
          <div>
            <button className="btn link small" onClick={() => setShowOverrides((v) => !v)}>
              {showOverrides ? 'Use the same caption everywhere' : 'Different caption for some accounts…'}
            </button>
            {showOverrides &&
              selected.map((a) => (
                <label className="field" key={a.id} style={{ marginTop: 10 }}>
                  <span>
                    {a.platform} · {a.name}
                  </span>
                  <textarea
                    style={{ minHeight: 70 }}
                    value={overrides[a.id] ?? ''}
                    placeholder="Same as main caption"
                    onChange={(e) =>
                      setOverrides((prev) => {
                        const next = { ...prev };
                        if (e.target.value === '') delete next[a.id];
                        else next[a.id] = e.target.value;
                        return next;
                      })
                    }
                  />
                </label>
              ))}
          </div>
        )}
      </section>

      <section className="card">
        <div className="card-head">
          <h2>3. Accounts</h2>
          {usable.length > 1 && (
            <div className="row">
              <button className="btn link small" onClick={() => setUnselected(new Set())}>
                All
              </button>
              <button className="btn link small" onClick={() => setUnselected(new Set(usable.map((a) => a.id)))}>
                None
              </button>
            </div>
          )}
        </div>
        {networkGroups.length > 1 && (
          <div className="network-chips" role="group" aria-label="Select a whole network">
            {networkGroups.map((g) => {
              const allOn = g.ids.every((id) => !unselected.has(id));
              return (
                <button
                  key={g.identifier}
                  className={`network-chip${allOn ? ' on' : ''}`}
                  onClick={() =>
                    setUnselected((prev) => {
                      const next = new Set(prev);
                      for (const id of g.ids) {
                        if (allOn) next.add(id);
                        else next.delete(id);
                      }
                      return next;
                    })
                  }
                >
                  {g.name} · {g.ids.length}
                </button>
              );
            })}
          </div>
        )}
        {loadError && <div className="notice error">{loadError}</div>}
        {accounts === null && !loadError && <p className="muted">Loading accounts…</p>}
        {accounts?.length === 0 && (
          <div className="empty">
            <p>No accounts connected yet.</p>
            <button className="btn primary" onClick={onGoAccounts}>
              Connect your first account
            </button>
          </div>
        )}
        <div className="account-list">
          {(accounts ?? []).map((a) => {
            const p = preview[a.id];
            const isUsable = a.supported && !a.disabled;
            const isSelected = isUsable && !unselected.has(a.id);
            const blocked = isSelected && (p?.problems.length ?? 0) > 0;
            return (
              <label
                key={a.id}
                className={`account${isUsable ? ' selectable' : ' blocked'}${isSelected && !blocked ? ' selected' : ''}${
                  blocked ? ' blocked' : ''
                }`}
              >
                <input type="checkbox" checked={isSelected} disabled={!isUsable} onChange={() => toggle(a.id)} />
                <AccountAvatar name={a.name} picture={a.picture} identifier={a.identifier} />
                <span className="account-main">
                  <span className="account-name">{a.name}</span>
                  <span className="account-meta">
                    {a.platform}
                    {!a.supported && ' · post to this one from Postiz'}
                    {a.disabled && ' · disabled in Postiz'}
                  </span>
                  {isSelected && p?.problems.map((msg) => <span key={msg} className="batch-error" style={{ display: 'block' }}>{msg}</span>)}
                  {isSelected &&
                    p?.warnings.map((msg) => (
                      <span key={msg} className="small" style={{ display: 'block', color: 'var(--warn)' }}>
                        {msg}
                      </span>
                    ))}
                </span>
                {isSelected && p && p.max > 0 && (
                  <span className="account-side">
                    <span style={{ color: p.over ? 'var(--warn)' : 'var(--muted)' }}>
                      {p.length}/{p.max}
                    </span>
                    {p.willShorten && (
                      <span className="small" style={{ display: 'block', color: 'var(--warn)' }}>
                        will be shortened
                      </span>
                    )}
                  </span>
                )}
              </label>
            );
          })}
        </div>
      </section>

      <section className="card stack">
        <h2>4. When</h2>
        <div className="segmented" role="group" aria-label="When to post">
          <button className={when === 'now' ? 'on' : ''} onClick={() => setWhen('now')}>
            Right now
          </button>
          <button className={when === 'later' ? 'on' : ''} onClick={() => setWhen('later')}>
            Schedule
          </button>
        </div>
        {when === 'later' && (
          <label className="field">
            <span>Date and time</span>
            <input
              type="datetime-local"
              value={scheduleAt}
              min={toLocalInputValue(new Date())}
              onChange={(e) => setScheduleAt(e.target.value)}
            />
          </label>
        )}
      </section>

      {skipped.length > 0 && (
        <div className="notice warn" style={{ marginBottom: 12 }}>
          {skipped.length === 1 ? '1 selected account will be skipped' : `${skipped.length} selected accounts will be skipped`}{' '}
          — see the red notes above.
        </div>
      )}
      {postError && (
        <div className="notice error" style={{ marginBottom: 12 }}>
          {postError}
        </div>
      )}
      <button className="btn primary big" disabled={!canPost} onClick={submit}>
        {posting
          ? 'Sending…'
          : media.phase === 'uploading' || media.phase === 'processing'
            ? 'Preparing your video…'
            : media.phase !== 'ready' && !caption.trim()
              ? 'Add a video or write a caption'
              : ready.length === 0
                ? selected.length === 0
                  ? 'Choose accounts to post to'
                  : 'Fix the red notes above to post'
                : `${when === 'now' ? 'Post' : 'Schedule'} to ${ready.length} account${ready.length === 1 ? '' : 's'}`}
      </button>
    </div>
  );
}
