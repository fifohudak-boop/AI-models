import { useCallback, useEffect, useState } from 'react';
import type { MetaFile, Model } from '../types';
import { api } from '../api';
import { formatBytes } from '../format';

const TAG_LABEL: Record<string, string> = {
  location: 'Location',
  device: 'Device',
  date: 'Date',
  'AI/edit tag': 'AI / edit tag',
  other: 'Other data',
};

// Strip the hidden data files carry (camera, GPS, dates, AI/edit tags) before posting. This only
// removes metadata — it never adds fake camera or "shot on" information.
export function MetadataPage({ model, toast, onSettings }: { model: Model; toast: (m: string) => void; onSettings: () => void }) {
  const [files, setFiles] = useState<MetaFile[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setFiles(null);
    try {
      setFiles(await api.metadataFiles(model.id));
      setSelected(new Set());
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [model.id]);

  useEffect(() => {
    load();
  }, [load]);

  const needsClean = (files ?? []).filter((f) => !f.clean);
  const alreadyClean = (files ?? []).filter((f) => f.clean);

  function toggle(path: string) {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  async function clean(paths: string[]) {
    if (paths.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.cleanMetadata(model.id, paths);
      toast(
        res.failed.length
          ? `Cleaned ${res.cleaned.length}, ${res.failed.length} couldn't be done`
          : `Cleaned ${res.cleaned.length} file${res.cleaned.length === 1 ? '' : 's'}`
      );
      if (res.failed.length) setError(res.failed.map((f) => `${f.name}: ${f.error}`).join('\n'));
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="card-head">
        <h1>Metadata · {model.name}</h1>
        <button className="btn small" onClick={load} disabled={busy}>
          Refresh
        </button>
      </div>

      <section className="card stack">
        <p className="small" style={{ margin: 0 }}>
          Photos and videos carry hidden data — the camera or app that made them, GPS location, dates, and AI or editing
          tags. Cleaning removes all of it, so what you post reveals nothing you didn't intend. This only strips metadata;
          it doesn't add fake camera information.
        </p>
        <div className="row">
          <button
            className="btn primary"
            disabled={busy || selected.size === 0}
            onClick={() => clean([...selected])}
          >
            {busy ? 'Cleaning…' : `Clean ${selected.size || ''} selected`}
          </button>
          <button
            className="btn"
            disabled={busy || needsClean.length === 0}
            onClick={() => clean(needsClean.map((f) => f.path))}
          >
            Clean everything that needs it ({needsClean.length})
          </button>
        </div>
      </section>

      {error && <div className="notice error" style={{ whiteSpace: 'pre-wrap' }}>{error}</div>}
      {!files && !error && <p className="muted">Scanning {model.name}'s files…</p>}

      {files && needsClean.length > 0 && (
        <section className="card">
          <h2>Carries hidden data ({needsClean.length})</h2>
          <div className="stack">
            {needsClean.map((f) => (
              <label key={f.path} className="meta-row">
                <input type="checkbox" checked={selected.has(f.path)} onChange={() => toggle(f.path)} />
                <img src={api.libraryThumb(model.id, f.path)} alt="" className="meta-thumb" loading="lazy" />
                <span className="meta-main">
                  <span className="meta-name">{f.name}</span>
                  <span className="muted small">
                    {f.folder} · {formatBytes(f.size)}
                  </span>
                </span>
                <span className="meta-tags">
                  {f.tags.map((t) => (
                    <span key={t} className="chip warn">
                      {TAG_LABEL[t] ?? t}
                    </span>
                  ))}
                </span>
              </label>
            ))}
          </div>
        </section>
      )}

      {files && alreadyClean.length > 0 && (
        <section className="card">
          <h2>Already clean ({alreadyClean.length})</h2>
          <div className="stack">
            {alreadyClean.map((f) => (
              <div key={f.path} className="meta-row">
                <span style={{ width: 18 }} />
                <img src={api.libraryThumb(model.id, f.path)} alt="" className="meta-thumb" loading="lazy" />
                <span className="meta-main">
                  <span className="meta-name">{f.name}</span>
                  <span className="muted small">
                    {f.folder} · {formatBytes(f.size)}
                  </span>
                </span>
                <span className="chip published">Clean</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {files && files.length === 0 && (
        <section className="card">
          <div className="empty">
            <p>No photos or videos yet. Connect this model's folders to clean up files before posting.</p>
            <button className="btn primary" onClick={onSettings}>
              Connect folders
            </button>
          </div>
        </section>
      )}
    </div>
  );
}
