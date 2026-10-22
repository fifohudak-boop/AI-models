import { useRef, useState } from 'react';
import type { Model } from '../types';
import { uploadStudioFile } from '../api';

type Kind = 'image' | 'video';

const IMAGE_RE = /\.(jpe?g|png|webp|gif|bmp|hei[cf]|tiff?|avif)$/i;
const VIDEO_RE = /\.(mp4|mov|m4v|webm|avi|mkv|m2ts|mpe?g)$/i;

function matches(file: File, accept: Kind): boolean {
  if (accept === 'image') return file.type.startsWith('image/') || IMAGE_RE.test(file.name);
  return file.type.startsWith('video/') || VIDEO_RE.test(file.name);
}

// Minimal shape of the (non-standard) drag-and-drop filesystem entry API, enough to walk folders.
type Entry = {
  isFile: boolean;
  isDirectory: boolean;
  file: (cb: (f: File) => void, err: (e: unknown) => void) => void;
  createReader: () => { readEntries: (cb: (e: Entry[]) => void, err: (e: unknown) => void) => void };
};

async function walk(entry: Entry, out: File[]): Promise<void> {
  if (entry.isFile) {
    out.push(await new Promise<File>((res, rej) => entry.file(res, rej)));
  } else if (entry.isDirectory) {
    const reader = entry.createReader();
    const read = () => new Promise<Entry[]>((res, rej) => reader.readEntries(res, rej));
    // readEntries returns in batches — keep calling until it's empty.
    for (let batch = await read(); batch.length; batch = await read()) {
      for (const e of batch) await walk(e, out);
    }
  }
}

// Everything dropped — recursing into any folders — then filtered to the kind this slot wants.
async function filesFromDrop(dt: DataTransfer, accept: Kind): Promise<File[]> {
  const items = Array.from(dt.items || []);
  const entries = items
    .map((it) => (it.webkitGetAsEntry ? (it.webkitGetAsEntry() as Entry | null) : null))
    .filter((e): e is Entry => !!e);
  if (entries.length) {
    const out: File[] = [];
    for (const e of entries) await walk(e, out);
    return out.filter((f) => matches(f, accept));
  }
  return Array.from(dt.files || []).filter((f) => matches(f, accept));
}

// Upload a set of files a few at a time, reporting how many are done.
async function uploadAll(
  modelId: string,
  files: File[],
  onEach: (done: number) => void,
  onError: (m: string) => void
): Promise<string[]> {
  const paths: string[] = [];
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < files.length) {
      const file = files[next++];
      try {
        const r = await uploadStudioFile(modelId, file);
        paths.push(r.path);
      } catch (e) {
        onError((e as Error).message);
      }
      onEach(++done);
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, files.length) }, worker));
  return paths;
}

// A "+" block: drag pictures or a whole folder onto it (or click to choose), and the files are
// uploaded into the model's drop area and handed back as paths. Also links to the model's folders.
export function DropZone({
  model,
  accept,
  multiple,
  label,
  hint,
  onAdd,
  onBrowse,
  disabled,
}: {
  model: Model;
  accept: Kind;
  multiple: boolean;
  label: string;
  hint?: string;
  onAdd: (paths: string[]) => void;
  onBrowse: () => void;
  disabled?: boolean;
}) {
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);

  async function ingest(all: File[]) {
    const files = multiple ? all : all.slice(0, 1);
    if (!files.length) {
      setError(`Drop ${accept === 'image' ? 'pictures' : 'videos'} here${multiple ? ' (or a folder of them)' : ''}.`);
      return;
    }
    setError(null);
    setBusy({ done: 0, total: files.length });
    const paths = await uploadAll(model.id, files, (done) => setBusy({ done, total: files.length }), setError);
    setBusy(null);
    if (paths.length) onAdd(paths);
  }

  async function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setOver(false);
    if (disabled || busy) return;
    ingest(await filesFromDrop(e.dataTransfer, accept));
  }

  const openFiles = () => !disabled && !busy && fileInput.current?.click();

  return (
    <div className="stack dropzone-wrap">
      <div
        className={`dropzone${over ? ' over' : ''}${disabled ? ' disabled' : ''}${busy ? ' busy' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          if (!disabled && !busy) setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
        onClick={openFiles}
        role="button"
        tabIndex={0}
        aria-label={label}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            openFiles();
          }
        }}
      >
        {busy ? (
          <span className="small">
            Uploading {busy.done}/{busy.total}…
          </span>
        ) : (
          <>
            <span className="dropzone-plus" aria-hidden="true">
              +
            </span>
            <span className="small dropzone-label">{label}</span>
            {hint && <span className="muted small">{hint}</span>}
          </>
        )}
      </div>
      <div className="row dropzone-actions">
        <button type="button" className="btn link small" onClick={openFiles} disabled={disabled || !!busy}>
          Choose {accept === 'image' ? (multiple ? 'pictures' : 'a picture') : 'a video'}
        </button>
        {multiple && (
          <button type="button" className="btn link small" onClick={() => folderInput.current?.click()} disabled={disabled || !!busy}>
            Choose a folder
          </button>
        )}
        <button type="button" className="btn link small" onClick={onBrowse} disabled={disabled || !!busy}>
          Browse {model.name}'s folders
        </button>
      </div>
      {error && <div className="notice error small">{error}</div>}
      <input
        ref={fileInput}
        type="file"
        accept={accept === 'image' ? 'image/*' : 'video/*'}
        multiple={multiple}
        hidden
        onChange={(e) => {
          ingest(Array.from(e.target.files || []));
          e.target.value = '';
        }}
      />
      {multiple && (
        <input
          ref={folderInput}
          type="file"
          hidden
          multiple
          // webkitdirectory turns this into a folder picker; not in the standard DOM types.
          {...({ webkitdirectory: '', directory: '' } as Record<string, string>)}
          onChange={(e) => {
            ingest(Array.from(e.target.files || []).filter((f) => matches(f, accept)));
            e.target.value = '';
          }}
        />
      )}
    </div>
  );
}
