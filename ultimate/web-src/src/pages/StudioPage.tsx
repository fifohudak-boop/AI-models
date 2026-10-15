import { useCallback, useEffect, useRef, useState } from 'react';
import type { LibraryItem, Model, StudioJob, StudioOptions } from '../types';
import type { Handoff } from '../App';
import { api } from '../api';
import { useLive } from '../live';
import { LibraryPicker } from '../components/LibraryPicker';

type Mode = 'text' | 'image' | 'reference';

const MODE_HELP: Record<Mode, string> = {
  text: 'Describe the video and Wan makes it from scratch.',
  image: 'Starts from a photo of the model (the first frame) and brings it to life.',
  reference:
    'Takes a reference video — e.g. one Reel Finder found — and makes it with your model: Wan copies its moves, camera and timing, with the person from the model photos. Up to 15 s of the reference is used (longer videos are cut).',
};

const RATIO_LABEL: Record<string, string> = {
  '9:16': '9:16 (Reels, TikTok, Shorts)',
  '3:4': '3:4 (Instagram portrait)',
  '1:1': '1:1 (square)',
  '4:3': '4:3',
  '16:9': '16:9 (YouTube)',
  '21:9': '21:9 (cinema)',
  adaptive: 'Like the input',
};

const STATUS_LABEL: Record<string, string> = {
  starting: 'Uploading',
  PENDING: 'Waiting for Wan',
  RUNNING: 'Wan is making it',
  downloading: 'Saving',
  saved: 'Saved',
  failed: 'Failed',
};

function fileName(path: string) {
  return path.split('/').pop() || path;
}

function Picked({ model, paths, onRemove }: { model: Model; paths: string[]; onRemove: (p: string) => void }) {
  if (paths.length === 0) return null;
  return (
    <div className="picked">
      {paths.map((p) => (
        <span key={p} className="picked-item" title={p}>
          <img src={api.libraryThumb(model.id, p)} alt="" />
          <span className="small">{fileName(p)}</span>
          <button type="button" className="ref-remove" aria-label={`Remove ${fileName(p)}`} onClick={() => onRemove(p)}>
            ×
          </button>
        </span>
      ))}
    </div>
  );
}

// AI Studio, for one model: make new videos of the model with Wan 3.0 (Alibaba Cloud Model Studio).
export function StudioPage({
  model,
  handoff,
  toast,
  onPost,
  onSettings,
}: {
  model: Model;
  handoff: Handoff | null;
  toast: (m: string) => void;
  onPost: (path: string) => void;
  onSettings: () => void;
}) {
  const [options, setOptions] = useState<StudioOptions | null>(null);
  const [jobs, setJobs] = useState<StudioJob[] | null>(null);
  const [mode, setMode] = useState<Mode>('reference');
  const [prompt, setPrompt] = useState('');
  const [videos, setVideos] = useState<string[]>([]);
  const [photos, setPhotos] = useState<string[]>([]);
  const [wan, setWan] = useState('wan3.0-video');
  const [resolution, setResolution] = useState('1080P');
  const [ratio, setRatio] = useState('9:16');
  const [duration, setDuration] = useState(5);
  const [autoLength, setAutoLength] = useState(true); // Wan picks the length (for a reference: like the reference)
  const [audio, setAudio] = useState(true);
  const [picking, setPicking] = useState<null | 'videos' | 'photos'>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setJobs(await api.studioJobs(model.id));
    } catch (err) {
      setError((err as Error).message);
    }
  }, [model.id]);

  useEffect(() => {
    api.modelStudioOptions(model.id).then(setOptions).catch(() => {});
    load();
  }, [load, model.id]);

  // This model's own connection (its own key, or the shared default if it has none).
  const connected = options?.connected ?? false;
  const needsWorkspace = options?.needsWorkspace ?? false;

  // Sent here from Reel Finder or the library.
  const handled = useRef(0);
  useEffect(() => {
    if (!handoff || handoff.at === handled.current) return;
    handled.current = handoff.at;
    if (handoff.kind === 'studio-video') {
      setMode('reference');
      setAutoLength(true);
      setVideos((v) => (v.includes(handoff.path) ? v : [...v, handoff.path].slice(-5)));
    } else {
      setMode((m) => (m === 'text' ? 'image' : m));
      setPhotos((p) => (p.includes(handoff.path) ? p : [...p, handoff.path].slice(-10)));
    }
  }, [handoff]);

  useLive((event) => {
    if (event.type !== 'studio_job' || event.model !== model.id) return;
    const job = event.data as StudioJob;
    setJobs((list) => {
      const rest = (list ?? []).filter((j) => j.id !== job.id);
      return [job, ...rest].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    });
    if (job.status === 'saved') toast(`AI Studio saved a video for ${model.name}`);
  });

  const maxVideos = options?.maxVideos ?? 5;
  const maxPhotos = options?.maxPhotos ?? 10;

  function choose(next: Mode) {
    setMode(next);
    setAutoLength(next === 'reference');
  }

  function pick(item: LibraryItem) {
    if (picking === 'videos') {
      if (item.kind !== 'video') return toast('Pick a video here.');
      setVideos((v) => (v.includes(item.path) ? v : [...v, item.path].slice(-maxVideos)));
    } else {
      if (item.kind !== 'image') return toast('Pick a photo here.');
      setPhotos((p) => (mode === 'image' ? [item.path] : p.includes(item.path) ? p : [...p, item.path].slice(-maxPhotos)));
    }
    setPicking(null);
  }

  async function generate() {
    setBusy(true);
    setError(null);
    try {
      const job = await api.createStudioJob(model.id, {
        mode,
        prompt,
        model: wan,
        resolution,
        ratio,
        duration: autoLength ? -1 : duration,
        audio,
        photos: mode === 'text' ? [] : mode === 'image' ? photos.slice(0, 1) : photos,
        videos: mode === 'reference' ? videos : [],
      });
      setJobs((list) => [job, ...(list ?? []).filter((j) => j.id !== job.id)]);
      toast('Sent to Wan — it usually takes a few minutes.');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const ready =
    connected &&
    !busy &&
    (mode === 'text' ? prompt.trim().length > 0 : mode === 'image' ? photos.length > 0 : videos.length > 0);

  // What this video will cost, from the rates in Settings (Wan bills per second of finished video).
  const rate = options?.rates?.[wan]?.[resolution];
  const estSeconds = autoLength ? options?.estimateSeconds ?? 5 : duration;
  const estCost = rate != null && estSeconds > 0 ? rate * estSeconds : null;
  const money = (n: number) => `${options?.currency === 'USD' ? '$' : ''}${n.toFixed(2)}${options?.currency && options.currency !== 'USD' ? ` ${options.currency}` : ''}`;

  return (
    <div>
      <div className="card-head">
        <h1>AI Studio · {model.name}</h1>
        <span className={`chip ${connected ? 'published' : 'draft'}`}>Wan 3.0 · {connected ? 'connected' : 'not connected yet'}</span>
      </div>

      {!connected && (
        <section className="card stack studio-connect">
          <h2>{needsWorkspace ? 'Add your workspace ID' : "Connect Alibaba's Wan 3.0"}</h2>
          <p className="small" style={{ margin: 0 }}>
            AI Studio makes new videos of {model.name} with <strong>Wan 3.0</strong> from Alibaba Cloud Model Studio: from a
            prompt, from a photo, or "like this reference video, but with {model.name}". The finished video lands in{' '}
            {model.name}'s library, ready to post with Fifofarm.
          </p>
          <p className="small muted" style={{ margin: 0 }}>
            {needsWorkspace
              ? `${model.name}'s API key is saved, but Wan 3.0 is served only on your workspace’s own address — add the Model Studio workspace ID in Settings → Models → ${model.name}'s AI Studio key to finish.`
              : `Give ${model.name} its own Alibaba Cloud Model Studio API key + workspace in Settings → Models → ${model.name}'s AI Studio key (or set a shared default key there). Each model can be on its own account.`}
          </p>
          <div className="row">
            <button className="btn primary" onClick={onSettings}>
              {needsWorkspace ? 'Add the workspace ID' : `Set ${model.name}'s key`}
            </button>
          </div>
        </section>
      )}

      {picking && (
        <LibraryPicker
          model={model}
          kinds={picking === 'videos' ? ['found', 'references', 'generated'] : ['photos', 'references', 'generated']}
          title={picking === 'videos' ? 'Pick a reference video' : `Pick photos of ${model.name}`}
          videosOnly={picking === 'videos'}
          imagesOnly={picking === 'photos'}
          onPick={pick}
          onClose={() => setPicking(null)}
        />
      )}

      <section className="card stack">
        <h2>Make a video</h2>
        <div className="segmented" role="radiogroup" aria-label="What to make">
          {(options?.modes ?? [
            { id: 'text', name: 'From a prompt' },
            { id: 'image', name: 'From a photo (first frame)' },
            { id: 'reference', name: 'Like a reference video, with your model' },
          ]).map((m) => (
            <button key={m.id} type="button" role="radio" aria-checked={mode === m.id} className={mode === m.id ? 'on' : ''} onClick={() => choose(m.id)}>
              {m.name}
            </button>
          ))}
        </div>
        <p className="muted small" style={{ margin: 0 }}>
          {MODE_HELP[mode]}
        </p>

        {mode === 'reference' && (
          <div className="stack">
            <div className="row">
              <strong className="small">Reference video{videos.length > 1 ? 's' : ''}</strong>
              <button type="button" className="btn small" onClick={() => setPicking('videos')}>
                Choose…
              </button>
            </div>
            <Picked model={model} paths={videos} onRemove={(p) => setVideos((v) => v.filter((x) => x !== p))} />
          </div>
        )}
        {mode !== 'text' && (
          <div className="stack">
            <div className="row">
              <strong className="small">
                {mode === 'image' ? `Photo of ${model.name} (the first frame)` : `Photos of ${model.name} (up to ${maxPhotos})`}
              </strong>
              <button type="button" className="btn small" onClick={() => setPicking('photos')}>
                Choose…
              </button>
              {!model.folders.photos && (
                <span className="muted small">
                  Tip: connect {model.name}'s photo folder in{' '}
                  <button type="button" className="btn link small" onClick={onSettings}>
                    Settings
                  </button>
                </span>
              )}
            </div>
            <Picked model={model} paths={photos} onRemove={(p) => setPhotos((v) => v.filter((x) => x !== p))} />
          </div>
        )}

        <label className="field">
          <span>{mode === 'text' ? 'Describe the video' : 'Anything to add? (optional)'}</span>
          {mode === 'reference' && (
            <span className="muted small" style={{ display: 'block', fontWeight: 'normal', marginBottom: 4 }}>
              Ultimate already tells Wan to copy the reference's moves with {model.name} from the photos — add anything else
              here (light, place, outfit…).
            </span>
          )}
          <textarea
            rows={3}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder={
              mode === 'text'
                ? `e.g. ${model.name} walking through a neon-lit street at night, slow motion, vertical video`
                : 'e.g. keep the same moves and camera, outdoor golden hour light'
            }
          />
        </label>

        <div className="row2">
          <label className="field">
            <span className="small">Wan version</span>
            <select value={wan} onChange={(e) => setWan(e.target.value)}>
              {(options?.models ?? [{ id: 'wan3.0-video', name: 'Wan 3.0' }]).map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="small">Shape</span>
            <select value={ratio} onChange={(e) => setRatio(e.target.value)}>
              {(options?.ratios ?? ['9:16']).map((r) => (
                <option key={r} value={r}>
                  {RATIO_LABEL[r] ?? r}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="small">Quality</span>
            <select value={resolution} onChange={(e) => setResolution(e.target.value)}>
              {(options?.resolutions ?? ['1080P']).map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </label>
          <div className="field">
            <span className="small">
              Length: {autoLength ? (mode === 'reference' ? 'like the reference' : 'Wan decides') : `${duration} s`}
            </span>
            <label className="check small">
              <input type="checkbox" checked={autoLength} onChange={(e) => setAutoLength(e.target.checked)} />
              <span>Auto</span>
            </label>
            {!autoLength && (
              <input
                type="range"
                min={options?.minDuration ?? 2}
                max={options?.maxDuration ?? 30}
                value={duration}
                aria-label="Length in seconds"
                onChange={(e) => setDuration(+e.target.value)}
              />
            )}
          </div>
        </div>
        <label className="check small">
          <input type="checkbox" checked={audio} onChange={(e) => setAudio(e.target.checked)} />
          <span>With sound (Wan makes matching audio)</span>
        </label>
        {!autoLength && mode === 'reference' && duration > 15 && (
          <p className="muted small" style={{ margin: 0 }}>
            With a reference video, its length plus the new video's can be 30 s at most — a long reference makes the new
            video shorter.
          </p>
        )}
        {connected && (
          <div className="cost-line">
            {estCost != null ? (
              <>
                <span className="cost-amount">{money(estCost)}</span>
                <span className="muted small">
                  {autoLength
                    ? `about, for ~${estSeconds}s (Auto length — final depends on the video Wan makes)`
                    : `for ${duration}s at ${resolution}`}
                </span>
              </>
            ) : (
              <span className="muted small">
                Set Wan's prices in{' '}
                <button type="button" className="btn link small" onClick={onSettings}>
                  Settings → AI Studio
                </button>{' '}
                to see the cost.
              </span>
            )}
          </div>
        )}
        {error && <div className="notice error small">{error}</div>}
        <button type="button" className="btn primary big" disabled={!ready} onClick={generate}>
          {!connected
            ? `Connect Wan 3.0 for ${model.name} first`
            : busy
              ? 'Sending…'
              : mode === 'reference' && videos.length === 0
                ? 'Choose a reference video'
                : mode === 'image' && photos.length === 0
                  ? `Choose a photo of ${model.name}`
                  : mode === 'text' && !prompt.trim()
                    ? 'Describe the video'
                    : `Make it for ${model.name}`}
        </button>
      </section>

      <section className="card">
        <h2>{model.name}'s AI videos</h2>
        {jobs === null ? (
          <p className="muted">Loading…</p>
        ) : jobs.length === 0 ? (
          <p className="muted small">Nothing made yet. What AI Studio makes for {model.name} shows up here and in the library.</p>
        ) : (
          <div className="stack">
            {jobs.map((job) => (
              <div key={job.id} className="studio-job">
                {job.file ? (
                  <img src={api.libraryThumb(model.id, job.file)} alt="" className="studio-thumb" />
                ) : (
                  <span className="studio-thumb empty" />
                )}
                <div className="account-main">
                  <div className="account-name">
                    {job.mode === 'text' ? 'From a prompt' : job.mode === 'image' ? 'From a photo' : 'Like a reference video'} ·{' '}
                    {job.seconds ? `${job.seconds}s` : job.duration === -1 ? 'auto length' : `${job.duration}s`} · {job.ratio} ·{' '}
                    {job.resolution}
                    {job.cost != null && (
                      <span className="cost-tag">
                        {job.costCurrency === 'USD' ? '$' : ''}
                        {job.cost.toFixed(2)}
                        {job.costCurrency && job.costCurrency !== 'USD' ? ` ${job.costCurrency}` : ''}
                      </span>
                    )}
                  </div>
                  <div className="account-meta" title={job.sentPrompt || job.prompt}>
                    {job.prompt || (job.videos[0] ? fileName(job.videos[0]) : job.photos[0] ? fileName(job.photos[0]) : '')}
                  </div>
                  {job.status !== 'saved' && job.status !== 'failed' && job.step && <div className="muted small">{job.step}…</div>}
                  {job.error && <div className="batch-error">{job.error}</div>}
                </div>
                <div className="account-side stack">
                  <span className={`chip ${job.status === 'saved' ? 'published' : job.status === 'failed' ? 'failed' : 'posting'}`}>
                    {STATUS_LABEL[job.status] ?? job.status}
                  </span>
                  {job.file && (
                    <div className="row">
                      <button className="btn primary small" onClick={() => onPost(job.file!)}>
                        Post
                      </button>
                      <button className="btn link small" onClick={() => api.openFolder(job.file!).catch((e) => toast(e.message))}>
                        Show
                      </button>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
