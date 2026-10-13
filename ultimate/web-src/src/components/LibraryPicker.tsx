import { useEffect, useState } from 'react';
import type { FolderKind, Library, LibraryItem, Model } from '../types';
import { api } from '../api';
import { LibraryGrid } from './LibraryGrid';
import { FOLDER_LABELS } from '../folders';

// "Choose from the library": the model's Reel Finder finds, AI Studio videos, references…
export function LibraryPicker({
  model,
  kinds,
  title,
  imagesOnly = false,
  videosOnly = false,
  onPick,
  onClose,
  onGoLibrary,
}: {
  model: Model;
  kinds: FolderKind[];
  title: string;
  imagesOnly?: boolean;
  videosOnly?: boolean;
  onPick: (item: LibraryItem) => void;
  onClose: () => void;
  onGoLibrary?: () => void;
}) {
  const [library, setLibrary] = useState<Library | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [kind, setKind] = useState<FolderKind>(kinds[0]);

  useEffect(() => {
    api
      .library(model.id)
      .then(setLibrary)
      .catch((err) => setError(err.message));
  }, [model.id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const folder = library?.[kind];
  const items = (folder?.items ?? []).filter((i) => (!imagesOnly || i.kind === 'image') && (!videosOnly || i.kind === 'video'));

  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal card stack" role="dialog" aria-modal="true" aria-label={title}>
        <div className="card-head" style={{ marginBottom: 0 }}>
          <h2>{title}</h2>
          <button className="btn small" onClick={onClose}>
            Close
          </button>
        </div>
        {kinds.length > 1 && (
          <div className="segmented" role="tablist">
            {kinds.map((k) => (
              <button key={k} role="tab" aria-selected={kind === k} className={kind === k ? 'on' : ''} onClick={() => setKind(k)}>
                {FOLDER_LABELS[k]}
                {library ? ` · ${library[k].items.length}` : ''}
              </button>
            ))}
          </div>
        )}
        {error && <div className="notice error">{error}</div>}
        {!library && !error && <p className="muted">Loading…</p>}
        {folder && !folder.connected && (
          <p className="muted">
            No {FOLDER_LABELS[kind].toLowerCase()} folder connected for {model.name} yet — connect one in Settings → Models.
          </p>
        )}
        {folder && folder.connected && items.length === 0 && (
          <p className="muted">Nothing here yet ({folder.folder}).</p>
        )}
        <div className="modal-scroll">
          <LibraryGrid model={model} items={items} onPick={onPick} />
        </div>
        {onGoLibrary && (
          <div className="row">
            <button
              className="btn link small"
              onClick={() => {
                onClose();
                onGoLibrary();
              }}
            >
              Open the library
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
