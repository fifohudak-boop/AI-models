import { useRef, useState } from 'react';
import type { Model, Reference } from '../../types';
import { api, uploadReference } from '../../api';
import { closenessHint, closenessLabel } from './common';

const MAX_REFERENCES = 5;

function ReferenceCard({ model, r, onRemove }: { model: Model; r: Reference; onRemove: () => void }) {
  const picks = r.frames <= 4 ? [...Array(r.frames).keys()] : [0, 2, 5, 7].filter((i) => i < r.frames);
  const name = r.source === 'link' ? (r.author ? `@${r.author}` : r.name) : r.name;
  const state = r.uploading
    ? 'Uploading…'
    : r.status === 'analyzing'
      ? r.step || 'Analysing…'
      : r.status === 'failed'
        ? `Couldn't use it: ${r.error}`
        : `Ready${r.tags?.length ? ` · ${r.tags.join(', ')}` : ''}`;
  return (
    <div className={`ref ref-${r.status}`}>
      <div className="ref-frames">
        {r.uploading
          ? '⤒'
          : picks.map((i) => <img key={i} alt="" loading="lazy" src={api.referenceFrame(model.id, r.id, i + 1)} />)}
      </div>
      <div className="ref-body">
        <div className="ref-name" title={r.name}>
          {name}
        </div>
        <div className="ref-state small">{state}</div>
        {r.description && <p className="ref-desc small">{r.description}</p>}
        {r.note && <p className="ref-note small">{r.note}</p>}
      </div>
      {!r.uploading && (
        <button type="button" className="ref-remove" aria-label={`Remove ${r.name}`} onClick={onRemove}>
          ×
        </button>
      )}
    </div>
  );
}

// "Find more videos like these": files from your Mac, links, or the model's own folders.
export function ReferencesPanel({
  model,
  references,
  setReferences,
  closeness,
  onCloseness,
  onFromLibrary,
  toast,
}: {
  model: Model;
  references: Map<string, Reference>;
  setReferences: (fn: (prev: Map<string, Reference>) => Map<string, Reference>) => void;
  closeness: number;
  onCloseness: (v: number) => void;
  onFromLibrary: () => void;
  toast: (m: string) => void;
}) {
  const [link, setLink] = useState('');
  const [over, setOver] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const refs = [...references.values()].sort((a, b) => a.created - b.created);
  const full = refs.length >= MAX_REFERENCES;

  async function upload(file: File) {
    if (references.size >= MAX_REFERENCES) {
      toast(`Up to ${MAX_REFERENCES} reference videos — remove one first.`);
      return;
    }
    if (!/^(video|image)\//.test(file.type) && !/\.(mp4|mov|m4v|webm|mkv|avi|gif|jpe?g|png|webp|heic)$/i.test(file.name)) {
      toast(`“${file.name}” isn't a video or picture.`);
      return;
    }
    const temp = `upload-${Date.now()}-${Math.random()}`;
    setReferences((prev) =>
      new Map(prev).set(temp, {
        id: temp, name: file.name, uploading: true, status: 'analyzing', created: Date.now() / 1000, frames: 0,
        source: 'file', url: '', kind: 'video', step: '', error: '', note: '', caption: '', author: '', platform: '',
        duration: null, description: '', queries: [], hashtags: [], tags: [], looks: false,
      })
    );
    try {
      const ref = await uploadReference(model.id, file);
      setReferences((prev) => (prev.has(ref.id) ? prev : new Map(prev).set(ref.id, ref)));
    } catch (err) {
      toast((err as Error).message);
    } finally {
      setReferences((prev) => {
        const next = new Map(prev);
        next.delete(temp);
        return next;
      });
    }
  }

  async function addLink(url: string) {
    url = url.trim();
    if (!url) return;
    try {
      const ref = await api.addReferenceLink(model.id, url);
      setReferences((prev) => (prev.has(ref.id) ? prev : new Map(prev).set(ref.id, ref)));
      setLink('');
    } catch (err) {
      toast((err as Error).message);
    }
  }

  return (
    <section className="card stack">
      <div className="card-head" style={{ marginBottom: 0 }}>
        <h2>Reference videos</h2>
        <span className="muted small">find more that look like these</span>
      </div>
      {!full && (
        <div
          className={`drop${over ? ' over' : ''}${refs.length ? ' compact' : ''}`}
          role="button"
          tabIndex={0}
          onClick={() => fileInput.current?.click()}
          onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && fileInput.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setOver(false);
            const files = [...(e.dataTransfer.files || [])];
            if (files.length) files.forEach(upload);
            else {
              const url = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain');
              if (url && /^https?:\/\//.test(url)) addLink(url);
            }
          }}
        >
          <strong>Drop a video here, or click to choose</strong>
          <span className="muted small">Videos or pictures from your Mac, up to {MAX_REFERENCES}</span>
        </div>
      )}
      <input
        ref={fileInput}
        type="file"
        accept="video/*,image/*"
        multiple
        hidden
        onChange={(e) => {
          [...(e.target.files || [])].forEach(upload);
          e.target.value = '';
        }}
      />
      <div className="row" style={{ flexWrap: 'nowrap' }}>
        <input
          type="url"
          placeholder="…or paste a video link"
          value={link}
          spellCheck={false}
          onChange={(e) => setLink(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              addLink(link);
            }
          }}
          aria-label="Link to a reference video"
        />
        <button type="button" className="btn small" onClick={() => addLink(link)}>
          Add
        </button>
      </div>
      <div className="row">
        <button type="button" className="btn small" onClick={onFromLibrary} disabled={full}>
          From {model.name}'s folders…
        </button>
      </div>
      {refs.length > 0 && (
        <div className="refs">
          {refs.map((r) => (
            <ReferenceCard
              key={r.id}
              model={model}
              r={r}
              onRemove={() =>
                api
                  .removeReference(model.id, r.id)
                  .then(() =>
                    setReferences((prev) => {
                      const next = new Map(prev);
                      next.delete(r.id);
                      return next;
                    })
                  )
                  .catch((err) => toast(err.message))
              }
            />
          ))}
        </div>
      )}
      {refs.length > 0 && (
        <label className="field">
          <span>
            How close to the reference: <span className="muted">{closenessLabel(closeness)}</span>
          </span>
          <input type="range" min={0} max={100} step={5} value={closeness} onChange={(e) => onCloseness(+e.target.value)} />
          <span className="scale small muted">
            <span>Same kind of video</span>
            <span>Nearly identical</span>
          </span>
          <span className="muted small">{closenessHint(closeness)}</span>
        </label>
      )}
    </section>
  );
}
