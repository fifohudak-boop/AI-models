import { useState } from 'react';
import type { LibraryItem, Model, PromptResult } from '../types';
import { api } from '../api';
import { LibraryPicker } from '../components/LibraryPicker';

// Prompt Making: pick one of this model's reference/found videos and turn it into a ready-to-generate
// text-to-video prompt (via the same local vision model Reel Finder uses). Paste it into AI Studio's
// Wan model — in "From a photo" mode from this model's photo — to recreate the clip as your model,
// at a plain 1× generation price instead of a 2× video-to-video edit.

// The structured fields, in the order they read best. "prompt" and "negative" get their own blocks.
const FIELDS: { key: keyof PromptResult['prompt']; label: string }[] = [
  { key: 'subject', label: 'Subject' },
  { key: 'wardrobe', label: 'Wardrobe' },
  { key: 'setting', label: 'Setting' },
  { key: 'lighting', label: 'Lighting' },
  { key: 'action', label: 'Action' },
  { key: 'camera', label: 'Camera' },
  { key: 'style', label: 'Style' },
  { key: 'mood', label: 'Mood' },
  { key: 'pacing', label: 'Pacing' },
  { key: 'audio', label: 'Audio' },
];

export function PromptMakerPage({
  model,
  toast,
  onUseInStudio,
}: {
  model: Model;
  toast: (m: string) => void;
  onUseInStudio: (prompt: string) => void;
}) {
  const [picking, setPicking] = useState(false);
  const [video, setVideo] = useState<LibraryItem | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<PromptResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function copy(text: string, what: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast(`${what} copied`);
    } catch {
      toast("Couldn't copy — select it and copy by hand.");
    }
  }

  async function make() {
    if (!video || busy) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setResult(await api.makePrompt(model.id, video.path));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const p = result?.prompt;

  return (
    <div className="page stack">
      {picking && (
        <LibraryPicker
          model={model}
          kinds={['found', 'references', 'generated']}
          title={`Pick a reference video for ${model.name}`}
          videosOnly
          onPick={(item) => {
            setVideo(item);
            setResult(null);
            setError(null);
            setPicking(false);
          }}
          onClose={() => setPicking(false)}
        />
      )}

      <section className="card stack">
        <h2>Prompt making</h2>
        <p className="muted small" style={{ margin: 0 }}>
          Turn a reference video into a ready-to-generate prompt. Your local AI model (the same one Reel
          Finder uses) watches the clip and writes a prompt you can paste straight into AI Studio’s Wan
          model — so you recreate it as {model.name} from a plain prompt, no video-to-video and no double
          billing. It describes the <strong>action and scene</strong>, not the face, so pair it with
          “From a photo” from {model.name}’s photo to carry the identity.
        </p>

        <div className="row" style={{ alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <button className="btn" onClick={() => setPicking(true)} disabled={busy}>
            {video ? 'Choose a different video' : 'Choose a reference video'}
          </button>
          {video && (
            <div className="row" style={{ alignItems: 'center', gap: 8 }}>
              <img src={api.libraryThumb(model.id, video.path)} alt="" className="studio-thumb" />
              <span className="small">{video.name}</span>
            </div>
          )}
        </div>

        <div className="row">
          <button className="btn primary" onClick={make} disabled={!video || busy}>
            {busy ? 'Reading the video and writing the prompt…' : 'Make the prompt'}
          </button>
        </div>
        {busy && (
          <p className="muted small" style={{ margin: 0 }}>
            This runs on your Mac with your local model — a few seconds to a minute depending on the model.
          </p>
        )}
        {error && <div className="notice error">{error}</div>}
      </section>

      {p && (
        <section className="card stack">
          <div className="card-head" style={{ marginBottom: 0 }}>
            <h2>The prompt</h2>
            <span className="muted small">
              {result?.model || 'local model'}
              {result?.seconds ? ` · ${result.seconds}s clip` : ''}
            </span>
          </div>
          {result?.warning && <div className="notice">{result.warning}</div>}

          <strong className="small">Paste this into AI Studio (Wan)</strong>
          <textarea className="prompt-out" readOnly rows={6} value={p.prompt} />
          <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
            <button className="btn primary" onClick={() => onUseInStudio(p.prompt)}>
              Use in AI Studio
            </button>
            <button className="btn" onClick={() => copy(p.prompt, 'Prompt')}>
              Copy prompt
            </button>
            <button className="btn link" onClick={() => copy(JSON.stringify(p, null, 2), 'JSON')}>
              Copy all as JSON
            </button>
          </div>

          {p.negative && (
            <>
              <strong className="small">Negative (things to avoid)</strong>
              <div className="row" style={{ alignItems: 'flex-start', gap: 8 }}>
                <textarea className="prompt-out" readOnly rows={2} value={p.negative} style={{ flex: 1 }} />
                <button className="btn small" onClick={() => copy(p.negative, 'Negative')}>
                  Copy
                </button>
              </div>
            </>
          )}

          <details className="stack">
            <summary className="small">The breakdown (tweak before you generate)</summary>
            <dl className="prompt-grid">
              {FIELDS.filter((f) => p[f.key]).map((f) => (
                <div key={f.key} className="prompt-row">
                  <dt className="muted small">{f.label}</dt>
                  <dd className="small">{p[f.key]}</dd>
                </div>
              ))}
            </dl>
          </details>
        </section>
      )}
    </div>
  );
}
