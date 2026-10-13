import { useCallback, useEffect, useState } from 'react';
import type { FolderKind, Library, Model } from '../types';
import type { Handoff } from '../App';
import { api } from '../api';
import { LibraryGrid } from '../components/LibraryGrid';
import { FOLDER_HINTS, FOLDER_LABELS } from '../folders';

const KINDS: FolderKind[] = ['found', 'generated', 'references', 'photos'];

// Everything of one model in one place: what Reel Finder found, what AI Studio made, your
// references and the model's photos — and from here, straight to the other tools.
export function LibraryPage({
  model,
  toast,
  onPost,
  onStudio,
  onReference,
  onSettings,
}: {
  model: Model;
  toast: (m: string) => void;
  onPost: (path: string) => void;
  onStudio: (kind: Handoff['kind'], path: string) => void;
  onReference: (path: string) => Promise<void>;
  onSettings: () => void;
}) {
  const [library, setLibrary] = useState<Library | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [kind, setKind] = useState<FolderKind>('found');

  const load = useCallback(async () => {
    try {
      setLibrary(await api.library(model.id));
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [model.id]);

  useEffect(() => {
    load();
  }, [load]);

  const folder = library?.[kind];

  return (
    <div>
      <div className="card-head">
        <h1>{model.name}'s library</h1>
        <div className="row">
          {folder?.connected && (
            <button className="btn small" onClick={() => api.openFolder(folder.folder).catch((e) => toast(e.message))}>
              Open in Finder
            </button>
          )}
          <button className="btn small" onClick={load}>
            Refresh
          </button>
        </div>
      </div>
      <div className="segmented" role="tablist" style={{ marginBottom: 14 }}>
        {KINDS.map((k) => (
          <button key={k} role="tab" aria-selected={kind === k} className={kind === k ? 'on' : ''} onClick={() => setKind(k)}>
            {FOLDER_LABELS[k]}
            {library ? ` · ${library[k].items.length}` : ''}
          </button>
        ))}
      </div>
      {error && <div className="notice error">{error}</div>}
      {!library && !error && <p className="muted">Loading…</p>}
      {folder && (
        <section className="card stack">
          <p className="muted small" style={{ margin: 0 }}>
            {FOLDER_HINTS[kind]} {folder.connected && <span className="mono">{folder.folder}</span>}
          </p>
          {!folder.connected ? (
            <div className="empty">
              <p>No folder connected for this yet.</p>
              <button className="btn primary" onClick={onSettings}>
                Connect a folder
              </button>
            </div>
          ) : folder.items.length === 0 ? (
            <div className="empty">
              <p>
                {kind === 'found'
                  ? `Nothing yet — start a hunt in Reel Finder and the best videos land here.`
                  : kind === 'generated'
                    ? 'Nothing yet — what AI Studio makes for this model lands here.'
                    : 'This folder has no videos or pictures yet.'}
              </p>
            </div>
          ) : (
            <LibraryGrid
              model={model}
              items={folder.items}
              renderActions={(item) => (
                <>
                  <span className="row lib-buttons">
                    <button className="btn primary small" onClick={() => onPost(item.path)}>
                      Post
                    </button>
                    <button
                      className="btn small"
                      onClick={() => onStudio(item.kind === 'video' ? 'studio-video' : 'studio-photo', item.path)}
                      title="Use it in AI Studio"
                    >
                      AI Studio
                    </button>
                  </span>
                  <span className="row lib-links">
                    {item.kind === 'video' && kind !== 'photos' && (
                      <button
                        className="btn link small"
                        onClick={() => onReference(item.path).catch((e) => toast((e as Error).message))}
                        title="Add it as a Reel Finder reference: the next hunt finds videos that look like this one"
                      >
                        More like it
                      </button>
                    )}
                    <button className="btn link small" onClick={() => api.openFolder(item.path).catch((e) => toast(e.message))}>
                      Show in Finder
                    </button>
                  </span>
                </>
              )}
            />
          )}
        </section>
      )}
    </div>
  );
}
