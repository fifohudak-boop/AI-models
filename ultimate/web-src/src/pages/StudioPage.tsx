import { useCallback, useEffect, useRef, useState } from 'react';
import type { LibraryItem, Model, StudioJob, StudioOptions } from '../types';
import type { Handoff } from '../App';
import { api } from '../api';
import { useLive } from '../live';
import { LibraryPicker } from '../components/LibraryPicker';
import { DropZone } from '../components/DropZone';

type Mode = 'text' | 'image' | 'reference';

const BATCH_MAX = 200; // mirrors studio.MAX_BATCH — a folder of pictures to recreate at once

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
  starting: 'Getting ready',
  PENDING: 'Waiting',
  RUNNING: 'Making it',
  downloading: 'Saving',
  saved: 'Saved',
  failed: 'Failed',
};

const money = (n: number) => `$${n.toFixed(2)}`;

function fileName(path: string) {
  return path.split('/').pop() || path;
}

function modeHelp(mode: Mode, kind: 'video' | 'image', name: string): string {
  if (kind === 'image') {
    if (mode === 'text') return `Describe the image and the model makes it from scratch.`;
    if (mode === 'image') return `Starts from a photo of ${name} and makes a new image from it.`;
    return `Pick the picture you want to recreate, plus a few photos of ${name} — it rebuilds that picture as ${name}. The reference picture and ${name}'s photos stay separate, so they're never mixed up.`;
  }
  if (mode === 'text') return 'Describe the video and it is made from scratch.';
  if (mode === 'image') return `Starts from a photo of ${name} (the first frame) and brings it to life.`;
  return `Takes a reference video — e.g. one Reel Finder found — and makes it with ${name}: the moves, camera and timing are copied, with the person from the model photos. Up to 15 s of the reference is used.`;
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

// AI Studio for one model: make videos (Wan / Seedance) or images (Seedream) with the model's own
// provider key. The price is shown automatically from the provider's published rates.
export function StudioPage({
  model,
  handoff,
  toast,
  onPost,
  onSettings,
  canManage = false,
}: {
  model: Model;
  handoff: Handoff | null;
  toast: (m: string) => void;
  onPost: (path: string) => void;
  onSettings: () => void;
  canManage?: boolean;
}) {
  const [options, setOptions] = useState<StudioOptions | null>(null);
  const [provider, setProvider] = useState('');
  const [jobs, setJobs] = useState<StudioJob[] | null>(null);
  const [mode, setMode] = useState<Mode>('reference');
  const [prompt, setPrompt] = useState('');
  const [videos, setVideos] = useState<string[]>([]);
  const [photos, setPhotos] = useState<string[]>([]);
  const [genModel, setGenModel] = useState('');
  const [resolution, setResolution] = useState('');
  const [ratio, setRatio] = useState('9:16');
  const [duration, setDuration] = useState(5);
  const [autoLength, setAutoLength] = useState(true);
  const [audio, setAudio] = useState(true);
  const [price, setPrice] = useState<number | null>(null);
  const [picking, setPicking] = useState<null | 'videos' | 'photos'>(null);
  // Which saved generations have their full prompt expanded — collapsed to one line by default so the
  // list stays short (a long prompt no longer blows up every card).
  const [openPrompts, setOpenPrompts] = useState<Set<string>>(() => new Set());
  const togglePrompt = (id: string) =>
    setOpenPrompts((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setJobs(await api.studioJobs(model.id));
    } catch (err) {
      setError((err as Error).message);
    }
  }, [model.id]);

  // Load options for one provider (the model's default-connected one, or the one you switch to) and
  // set sensible defaults for it. Switching provider just refetches — your saved keys do the rest.
  const loadOptions = useCallback(
    (providerId?: string) => {
      api
        .modelStudioOptions(model.id, providerId)
        .then((o) => {
          setOptions(o);
          setProvider(o.provider);
          const modes = o.modes.map((x) => x.id);
          setMode(modes.includes('reference') ? 'reference' : (modes[0] as Mode));
          setGenModel(o.models[0]?.id ?? '');
          // Default to a mid quality (720p for video, 2K for images), not the priciest top tier — a
          // 1080p clip can cost ~2× a 720p one, so top quality is a deliberate choice, not the default.
          setResolution(o.resolutions[1] ?? o.resolutions[0]);
          setRatio(o.ratios[0] ?? '9:16');
          setDuration(o.durations.default || 5);
          setAutoLength(o.durations.auto);
          setVideos([]); // the reference slot is a video for Wan but a picture for image providers
        })
        .catch(() => {});
    },
    [model.id]
  );

  useEffect(() => {
    loadOptions();
    load();
  }, [loadOptions, load]);

  const kind = options?.kind ?? 'video';
  const connected = options?.connected ?? false;
  const needsWorkspace = options?.needsWorkspace ?? false;
  const providerName = options?.providerName ?? 'a provider';
  const isImage = kind === 'image';
  const faceSwap = options?.provider === 'facefusion';  // local face swap: no prompt, length or quality to pick
  // "From a photo" takes several reference pictures where the model reads them all — every image model,
  // and ArgoLink video (reference-to-video). A plain video first frame stays a single picture.
  const multiRef = isImage || options?.provider === 'argolink-video';
  const connectedProviders = (options?.providers ?? []).filter((p) => p.connected);

  // Sent here from Reel Finder or the library.
  const handled = useRef(0);
  useEffect(() => {
    if (!handoff || handoff.at === handled.current || !options) return;
    handled.current = handoff.at;
    const modes = options.modes.map((x) => x.id);
    if (handoff.kind === 'studio-prompt') {
      // From Prompt Making: drop the generated prompt in and switch to "From a photo" (image-to-video),
      // which is what carries this model's identity — the prompt only recreates the action and scene.
      if (handoff.prompt) setPrompt(handoff.prompt);
      setMode(modes.includes('image') ? 'image' : (modes[0] as Mode));
    } else if (handoff.kind === 'studio-video' && options.kind !== 'image' && modes.includes('reference')) {
      setMode('reference');
      setAutoLength(options.durations.auto);
      setVideos((v) => (v.includes(handoff.path) ? v : [...v, handoff.path].slice(-5)));
    } else if (handoff.kind !== 'studio-video' && modes.includes('image')) {
      setMode('image');
      setPhotos((p) => (p.includes(handoff.path) ? p : [...p, handoff.path].slice(-10)));
    }
  }, [handoff, options]);

  useLive((event) => {
    if (event.type !== 'studio_job' || event.model !== model.id) return;
    const job = event.data as StudioJob;
    setJobs((list) => {
      const rest = (list ?? []).filter((j) => j.id !== job.id);
      return [job, ...rest].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    });
    if (job.status === 'saved') toast(`AI Studio saved ${job.kind === 'image' ? 'an image' : 'a video'} for ${model.name}`);
  });

  const maxVideos = options?.maxVideos ?? 5;
  const maxPhotos = options?.maxPhotos ?? 10;
  const modes = options?.modes ?? [{ id: 'text', name: 'From a prompt' }];

  // Recreating a folder: one output per reference picture, so the price (and the count) scale with it.
  const batchCount = isImage && mode === 'reference' ? Math.max(1, videos.length) : 1;

  // The automatic price, from the provider's rates, for the current settings (× the batch count).
  const estSeconds = isImage ? 0 : autoLength ? options?.estimateSeconds ?? 5 : duration;
  useEffect(() => {
    if (!connected || !genModel || !resolution) {
      setPrice(null);
      return;
    }
    let live = true;
    api
      .studioPrice(model.id, genModel, resolution, estSeconds, batchCount, provider)
      .then((r) => live && setPrice(r.price))
      .catch(() => live && setPrice(null));
    return () => {
      live = false;
    };
  }, [connected, genModel, resolution, estSeconds, batchCount, model.id, provider]);

  // Files chosen in any way (dragged in, a folder, or picked from the library) all land here.
  const addVideos = (paths: string[]) =>
    setVideos((v) => [...v, ...paths.filter((p) => !v.includes(p))].slice(-(isImage ? BATCH_MAX : maxVideos)));
  const addPhotos = (paths: string[]) =>
    setPhotos((p) =>
      mode === 'image' && !multiRef
        ? paths.slice(-1)
        : [...p, ...paths.filter((x) => !p.includes(x))].slice(-maxPhotos)
    );

  function choose(next: Mode) {
    setMode(next);
    if (options) setAutoLength(next === 'reference' && options.durations.auto);
  }

  // "Edit" on a saved output: drop it straight back into the reference slot and switch to recreate
  // mode, so a picture (or video) you just made can be refined without hunting for it in the library.
  function reuse(file: string) {
    choose('reference');
    addVideos([file]);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function pick(item: LibraryItem) {
    if (picking === 'videos') {
      // Image providers: the "reference" slot holds the picture(s) to recreate (kept separate from
      // the model photos). Video providers: reference videos.
      if (isImage) {
        if (item.kind !== 'image') return toast('Pick an image here.');
        addVideos([item.path]);
      } else {
        if (item.kind !== 'video') return toast('Pick a video here.');
        addVideos([item.path]);
      }
    } else {
      if (item.kind !== 'image') return toast('Pick a photo here.');
      addPhotos([item.path]);
    }
    setPicking(null);
  }

  async function generate() {
    setBusy(true);
    setError(null);
    try {
      const job = await api.createStudioJob(model.id, {
        provider,
        mode,
        prompt,
        model: genModel,
        resolution,
        ratio,
        duration: isImage ? null : autoLength ? -1 : duration,
        audio,
        photos: mode === 'text' ? [] : mode === 'image' && !multiRef ? photos.slice(0, 1) : photos,
        videos: mode === 'reference' ? videos : [],
      });
      setJobs((list) => [job, ...(list ?? []).filter((j) => j.id !== job.id)]);
      toast(
        isImage
          ? batchCount > 1
            ? `Recreating ${batchCount} pictures…`
            : 'Making the image…'
          : 'Sent — it usually takes a few minutes.'
      );
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

  const verb = isImage ? 'image' : 'video';
  const showReference = modes.some((x) => x.id === 'reference');

  return (
    <div>
      <div className="card-head">
        <h1>AI Studio · {model.name}</h1>
        <span className={`chip ${connected ? 'published' : 'draft'}`}>
          {providerName} · {connected ? 'connected' : 'not connected yet'}
        </span>
      </div>

      {connectedProviders.length > 1 && (
        <div className="stack" style={{ marginBottom: 12 }}>
          <span className="small muted">Provider — switch any time, each uses its own saved key</span>
          <div className="segmented" role="radiogroup" aria-label="Provider">
            {connectedProviders.map((p) => (
              <button
                key={p.id}
                type="button"
                role="radio"
                aria-checked={provider === p.id}
                className={provider === p.id ? 'on' : ''}
                onClick={() => loadOptions(p.id)}
              >
                {p.name}
                {p.kind === 'image' ? ' · images' : ''}
              </button>
            ))}
          </div>
        </div>
      )}

      {!connected && (
        <section className="card stack studio-connect">
          <h2>{needsWorkspace ? 'Add your workspace ID' : 'Connect a video or image provider'}</h2>
          <p className="small" style={{ margin: 0 }}>
            AI Studio makes new videos and images of {model.name}. Connect a key for any provider — Alibaba{' '}
            <strong>Wan</strong>, ByteDance <strong>Seedance</strong>, WaveSpeed or VideoRouter for video, ByteDance{' '}
            <strong>Seedream</strong> or ArgoLink (<strong>Nano Banana Pro</strong>) for images. Connect several and switch
            between them here; each is its own paid account.
          </p>
          <p className="small muted" style={{ margin: 0 }}>
            {needsWorkspace
              ? `${model.name}'s Wan key is saved, but Wan is served only on your workspace's own address — add the Model Studio workspace ID in Settings → ${model.name} → AI Studio keys to finish.`
              : `Connect ${model.name}'s keys in Settings → ${model.name} → AI Studio keys.`}
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
          kinds={
            picking === 'videos'
              ? isImage
                ? ['references', 'found', 'generated', 'photos']
                : ['found', 'references', 'generated']
              : ['photos', 'references', 'generated']
          }
          title={picking === 'videos' ? (isImage ? 'Pick a picture to recreate' : 'Pick a reference video') : `Pick a photo of ${model.name}`}
          videosOnly={picking === 'videos' && !isImage}
          imagesOnly={picking === 'photos' || (picking === 'videos' && isImage)}
          onPick={pick}
          onClose={() => setPicking(null)}
        />
      )}

      <section className="card stack">
        <h2>Make {isImage ? 'an image' : 'a video'}</h2>
        {modes.length > 1 && (
          <div className="segmented" role="radiogroup" aria-label="What to make">
            {modes.map((m) => (
              <button key={m.id} type="button" role="radio" aria-checked={mode === m.id} className={mode === m.id ? 'on' : ''} onClick={() => choose(m.id)}>
                {m.name}
              </button>
            ))}
          </div>
        )}
        <p className="muted small" style={{ margin: 0 }}>
          {modeHelp(mode, kind, model.name)}
        </p>

        {mode === 'reference' && showReference && (
          <div className="stack">
            <strong className="small dz-label">
              {isImage
                ? `Picture${videos.length === 1 ? '' : 's'} to recreate${videos.length > 1 ? ` · ${videos.length}` : ''}`
                : `Reference video${videos.length > 1 ? 's' : ''}`}
            </strong>
            <span className="muted small" style={{ marginTop: -4 }}>
              {isImage
                ? `The picture whose pose, scene and style you want to copy. Drop one — or a whole folder to recreate every picture in it as ${model.name}, same prompt for all. Kept separate from ${model.name}'s photos below.`
                : faceSwap
                  ? `The clip to swap the face into — its scene, motion, timing and audio all stay; only the face becomes ${model.name}.`
                  : `The video whose moves, camera and timing you want — e.g. one Reel Finder found. Up to 15 s is used.`}
            </span>
            <DropZone
              model={model}
              accept={isImage ? 'image' : 'video'}
              multiple
              label={isImage ? 'Drag pictures or a whole folder here' : 'Drag a reference video here'}
              hint="or click to choose"
              onAdd={addVideos}
              onBrowse={() => setPicking('videos')}
            />
            <Picked model={model} paths={videos} onRemove={(p) => setVideos((v) => v.filter((x) => x !== p))} />
          </div>
        )}
        {(mode === 'image' || mode === 'reference') && (
          <div className="stack">
            <strong className="small dz-label">
              {faceSwap
                ? `Photo of ${model.name} — the face`
                : mode === 'reference' || (mode === 'image' && multiRef)
                  ? `Photos of ${model.name}${photos.length > 1 ? ` · ${photos.length}` : ''} (up to ${maxPhotos})`
                  : `Photo of ${model.name}${isImage ? ' to start from' : ' (the first frame)'}`}
            </strong>
            {mode === 'image' && multiRef && (
              <span className="muted small" style={{ marginTop: -4 }}>
                Add several pictures of {model.name} — different angles, outfits and expressions — and the
                model uses them all as references, so it captures the look better than one photo.
              </span>
            )}
            {mode === 'reference' && (
              <span className="muted small" style={{ marginTop: -4 }}>
                {isImage
                  ? `${model.name}'s face, hair, body and look — put into every recreated picture (kept separate from the reference above).`
                  : faceSwap
                    ? `${model.name}'s face — swapped into the clip above. One clear, front-facing photo works best.`
                    : `These are the person Wan puts into the reference — ${model.name}'s face, hair, body and look.`}
              </span>
            )}
            <DropZone
              model={model}
              accept="image"
              multiple={mode !== 'image' || multiRef}
              label={
                mode === 'image' && !multiRef
                  ? 'Drag a photo here'
                  : `Drag ${model.name}'s photos (or a folder) here`
              }
              hint="or click to choose"
              onAdd={addPhotos}
              onBrowse={() => setPicking('photos')}
            />
            <Picked model={model} paths={photos} onRemove={(p) => setPhotos((v) => v.filter((x) => x !== p))} />
          </div>
        )}

        {!faceSwap && (
        <label className="field">
          <span>{mode === 'text' ? `Describe the ${verb}` : 'Anything to add? (optional)'}</span>
          {mode === 'reference' && (
            <span className="muted small" style={{ display: 'block', fontWeight: 'normal', marginBottom: 4 }}>
              {isImage
                ? `Ultimate already tells the model to rebuild the reference picture as ${model.name} — add anything else here (outfit, light, place…).`
                : `Ultimate already tells the model to copy the reference's moves with ${model.name} from the photos — add anything else here (light, place, outfit…).`}
            </span>
          )}
          <textarea
            rows={3}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder={
              mode === 'text'
                ? isImage
                  ? `e.g. ${model.name} on a city rooftop at golden hour, portrait, natural light`
                  : `e.g. ${model.name} walking through a neon-lit street at night, slow motion, vertical`
                : 'e.g. keep the same look, outdoor golden hour light'
            }
          />
        </label>
        )}

        <div className="row2">
          <label className="field">
            <span className="small">{options?.provider === 'wan' ? 'Wan version' : 'Model'}</span>
            <select value={genModel} onChange={(e) => setGenModel(e.target.value)}>
              {(options?.models ?? []).map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </label>
          {(options?.ratios?.length ?? 0) > 1 && (
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
          )}
          {(options?.resolutions?.length ?? 0) > 1 && (
            <label className="field">
              <span className="small">Quality</span>
              <select value={resolution} onChange={(e) => setResolution(e.target.value)}>
                {(options?.resolutions ?? []).map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </label>
          )}
          {!isImage && (options?.durations.max ?? 0) > 0 && (
            <div className="field">
              <span className="small">
                Length: {autoLength ? (mode === 'reference' ? 'like the reference' : 'auto') : `${duration} s`}
              </span>
              {options?.durations.auto && (
                <label className="check small">
                  <input type="checkbox" checked={autoLength} onChange={(e) => setAutoLength(e.target.checked)} />
                  <span>Auto</span>
                </label>
              )}
              {!autoLength && (
                <input
                  type="range"
                  min={options?.durations.min ?? 2}
                  max={options?.durations.max ?? 30}
                  value={duration}
                  aria-label="Length in seconds"
                  onChange={(e) => setDuration(+e.target.value)}
                />
              )}
            </div>
          )}
        </div>
        {!isImage && (options?.durations.max ?? 0) > 0 && (
          <label className="check small">
            <input type="checkbox" checked={audio} onChange={(e) => setAudio(e.target.checked)} />
            <span>With sound (matching audio)</span>
          </label>
        )}
        {!isImage && !autoLength && mode === 'reference' && duration > 15 && (
          <p className="muted small" style={{ margin: 0 }}>
            With a reference video, its length plus the new video's can be 30 s at most — a long reference makes the new
            video shorter.
          </p>
        )}

        {connected && (
          <div className="cost-line">
            {price != null ? (
              <>
                <span className="cost-amount">{money(price)}</span>
                <span className="muted small">
                  {isImage
                    ? batchCount > 1
                      ? `for ${batchCount} pictures · ${money(price / batchCount)} each, automatic from the provider’s price`
                      : 'per image, automatic from the provider’s price'
                    : autoLength
                      ? `rough, for ~${estSeconds}s — auto length lets the model choose, up to ${options?.durations.max ?? 30}s, so it can cost several × this (≈${money((price / Math.max(estSeconds, 1)) * (options?.durations.max ?? 30))} at the longest)`
                      : `for ${duration}s at ${resolution}, automatic from the provider’s price`}
                </span>
              </>
            ) : (
              <span className="muted small">Price shown once the provider and model are set.</span>
            )}
          </div>
        )}
        {provider === 'argolink-video' && mode === 'reference' && (
          <p className="muted small" style={{ margin: 0 }}>
            Recreate keeps your clip’s length and bills about <strong>2×</strong> it — ArgoLink counts your clip as both
            the input and the output. The exact cost is shown once it’s made. Wan 3.0 is the cheapest for this.
          </p>
        )}
        {error && <div className="notice error small">{error}</div>}
        <button type="button" className="btn primary big" disabled={!ready} onClick={generate}>
          {!connected
            ? `Connect ${model.name}'s provider first`
            : busy
              ? 'Sending…'
              : mode === 'reference' && videos.length === 0
                ? isImage
                  ? 'Add a picture (or folder) to recreate'
                  : 'Choose a reference video'
                : mode === 'image' && photos.length === 0
                  ? `Choose a photo of ${model.name}`
                  : mode === 'text' && !prompt.trim()
                    ? `Describe the ${verb}`
                    : isImage && mode === 'reference' && batchCount > 1
                      ? `Recreate ${batchCount} pictures for ${model.name}`
                      : `Make ${isImage ? 'the image' : 'it'} for ${model.name}`}
        </button>
      </section>

      <section className="card">
        <h2>{model.name}'s AI {isImage ? 'images' : 'videos'}</h2>
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
                    {job.kind === 'image'
                      ? `${
                          job.mode === 'reference'
                            ? (job.total ?? 1) > 1
                              ? `Recreated ${job.done ?? job.total} of ${job.total} pictures`
                              : 'Recreated picture'
                            : job.mode === 'image'
                              ? 'From a photo'
                              : 'Image'
                        } · ${job.ratio} · ${job.resolution}`
                      : `${job.mode === 'text' ? 'From a prompt' : job.mode === 'image' ? 'From a photo' : 'Like a reference video'} · ${
                          job.seconds ? `${job.seconds}s` : job.duration === -1 ? 'auto length' : `${job.duration}s`
                        } · ${job.ratio} · ${job.resolution}`}
                    {job.cost != null && <span className="cost-tag">{money(job.cost)}</span>}
                  </div>
                  {job.prompt ? (
                    <button
                      type="button"
                      className={`studio-prompt${openPrompts.has(job.id) ? ' open' : ''}`}
                      onClick={() => togglePrompt(job.id)}
                      title={openPrompts.has(job.id) ? 'Hide the prompt' : 'Show the full prompt'}
                    >
                      <span className="studio-prompt-text">{job.prompt}</span>
                      <span className="studio-prompt-caret" aria-hidden="true">
                        {openPrompts.has(job.id) ? '⌃' : '⌄'}
                      </span>
                    </button>
                  ) : (
                    <div className="account-meta">
                      {job.videos[0] ? fileName(job.videos[0]) : job.photos[0] ? fileName(job.photos[0]) : ''}
                    </div>
                  )}
                  {job.status !== 'saved' && job.status !== 'failed' && job.step && <div className="muted small">{job.step}…</div>}
                  {job.status === 'saved' && (job.failedCount ?? 0) > 0 && (
                    <div className="muted small">{job.failedCount} couldn’t be recreated</div>
                  )}
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
                      {showReference && (job.kind === 'image') === isImage && (
                        <button className="btn small" onClick={() => reuse(job.file!)}>
                          Edit
                        </button>
                      )}
                      {canManage && (
                        <button className="btn link small" onClick={() => api.openFolder(job.file!).catch((e) => toast(e.message))}>
                          Show
                        </button>
                      )}
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
