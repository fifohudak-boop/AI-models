import { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { EditCaptionColor, EditJob, EditOptions, LibraryItem, Model } from '../types';
import type { Handoff } from '../App';
import { api, uploadMusic } from '../api';
import { useLive } from '../live';
import { LibraryPicker } from '../components/LibraryPicker';

type Caption = { text: string; position: string; size: string; style: string; color: string };

const STATUS_LABEL: Record<string, string> = {
  starting: 'Getting ready',
  processing: 'Building',
  saved: 'Done',
  failed: 'Failed',
};

// Caption height as a fraction of the reel height — matches the renderer (editor.CAPTION_SIZES).
const SIZE_SCALE: Record<string, number> = { S: 0.045, M: 0.062, L: 0.085, XL: 0.11 };
const SIZE_LABEL: Record<string, string> = { S: 'Small', M: 'Medium', L: 'Large', XL: 'Huge' };
const STYLE_LABEL: Record<string, string> = { outline: 'Outline', box: 'Chip', plain: 'Shadow' };
const ASPECT_WH: Record<string, [number, number]> = {
  '9:16': [9, 16],
  '4:5': [4, 5],
  '1:1': [1, 1],
  '16:9': [16, 9],
};

function clock(s: number) {
  if (!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  const t = Math.floor((s * 10) % 10);
  return `${m}:${sec.toString().padStart(2, '0')}.${t}`;
}

// ---- the caption, drawn to look about like the finished reel ----
function captionCss(c: Caption, colors: EditCaptionColor[]): CSSProperties {
  const rgb = colors.find((x) => x.id === c.color)?.rgb ?? [255, 255, 255];
  const col = `rgb(${rgb.join(',')})`;
  const light = rgb[0] * 0.299 + rgb[1] * 0.587 + rgb[2] * 0.114 > 150;
  const edge = light ? '#111' : '#fff';
  const base: CSSProperties = { color: col, fontSize: `${SIZE_SCALE[c.size] * 100}cqh` };
  if (c.style === 'box') {
    return { ...base, background: 'rgba(0,0,0,.66)', padding: '0.16em 0.5em', borderRadius: '0.3em' };
  }
  if (c.style === 'plain') {
    return { ...base, textShadow: '0.04em 0.05em 0 rgba(0,0,0,.6)' };
  }
  return {
    ...base,
    WebkitTextStroke: `0.09em ${edge}`,
    paintOrder: 'stroke fill',
    textShadow: '0 0.02em 0.12em rgba(0,0,0,.4)',
  } as CSSProperties;
}

function CaptionLayer({ captions, colors }: { captions: Caption[]; colors: EditCaptionColor[] }) {
  return (
    <>
      {captions.map(
        (c, i) =>
          c.text.trim() && (
            <div
              key={i}
              className={`stage-caption ${c.position}`}
              style={c.position === 'middle' ? { top: '50%', transform: 'translateY(-50%)' } : undefined}
            >
              <span style={captionCss(c, colors)}>{c.text}</span>
            </div>
          )
      )}
    </>
  );
}

// ---- the iPhone-style trim bar: a filmstrip, two handles, a playhead ----
function TrimBar({
  duration,
  start,
  end,
  playhead,
  filmstrip,
  onTrim,
  onScrub,
}: {
  duration: number;
  start: number;
  end: number;
  playhead: number;
  filmstrip: string | null;
  onTrim: (start: number, end: number) => void;
  onScrub: (t: number) => void;
}) {
  const barRef = useRef<HTMLDivElement>(null);
  const drag = useRef<null | 'start' | 'end' | 'seek'>(null);
  const pct = (t: number) => `${duration > 0 ? Math.min(100, Math.max(0, (t / duration) * 100)) : 0}%`;

  const timeFromX = useCallback(
    (clientX: number) => {
      const el = barRef.current;
      if (!el || duration <= 0) return 0;
      const rect = el.getBoundingClientRect();
      return Math.min(duration, Math.max(0, ((clientX - rect.left) / rect.width) * duration));
    },
    [duration]
  );

  const apply = useCallback(
    (which: 'start' | 'end' | 'seek', clientX: number) => {
      const t = timeFromX(clientX);
      if (which === 'start') {
        const s = Math.max(0, Math.min(t, end - 0.3));
        onTrim(s, end);
        onScrub(s);
      } else if (which === 'end') {
        const e = Math.min(duration, Math.max(t, start + 0.3));
        onTrim(start, e);
        onScrub(e);
      } else {
        onScrub(Math.min(Math.max(t, start), end));
      }
    },
    [timeFromX, start, end, duration, onTrim, onScrub]
  );

  useEffect(() => {
    const move = (e: PointerEvent) => drag.current && apply(drag.current, e.clientX);
    const up = () => (drag.current = null);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
  }, [apply]);

  const grab = (which: 'start' | 'end' | 'seek') => (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    drag.current = which;
    apply(which, e.clientX);
  };

  return (
    <div className="trim">
      <div
        className="trim-bar"
        ref={barRef}
        style={filmstrip ? { backgroundImage: `url(${filmstrip})` } : undefined}
        onPointerDown={grab('seek')}
      >
        <div className="trim-dim" style={{ left: 0, width: pct(start) }} />
        <div className="trim-dim" style={{ left: pct(end), right: 0 }} />
        <div className="trim-window" style={{ left: pct(start), right: `calc(100% - ${pct(end)})` }}>
          <div className="trim-handle left" onPointerDown={grab('start')} role="slider" aria-label="Trim start" tabIndex={0}>
            <span />
          </div>
          <div className="trim-handle right" onPointerDown={grab('end')} role="slider" aria-label="Trim end" tabIndex={0}>
            <span />
          </div>
        </div>
        {playhead >= start && playhead <= end && <div className="trim-playhead" style={{ left: pct(playhead) }} />}
      </div>
      <div className="trim-times">
        <span>{clock(start)}</span>
        <span className="muted">keeping {clock(end - start)}</span>
        <span>{clock(end)}</span>
      </div>
    </div>
  );
}

// The Editor: take a clip, trim it, shape it, add captions and music, and save a ready reel.
export function EditPage({
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
  const [options, setOptions] = useState<EditOptions | null>(null);
  const [source, setSource] = useState<string | null>(null);
  const [duration, setDuration] = useState(0);
  const [natural, setNatural] = useState<[number, number]>([9, 16]);
  const [trimStart, setTrimStart] = useState(0);
  const [trimEnd, setTrimEnd] = useState(0);
  const [aspect, setAspect] = useState('9:16');
  const [fill, setFill] = useState('crop');
  const [mirror, setMirror] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [captions, setCaptions] = useState<Caption[]>([]);
  const [active, setActive] = useState(0);
  const [music, setMusic] = useState('');
  const [musicList, setMusicList] = useState<{ name: string }[]>([]);
  const [musicVolume, setMusicVolume] = useState(0.8);
  const [keepOriginalAudio, setKeepOriginalAudio] = useState(true);
  const [fade, setFade] = useState(true);
  const [picking, setPicking] = useState(false);
  const [jobs, setJobs] = useState<EditJob[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [playhead, setPlayhead] = useState(0);

  const videoRef = useRef<HTMLVideoElement>(null);
  const bgRef = useRef<HTMLVideoElement>(null);
  const handled = useRef(0);

  const loadJobs = useCallback(() => {
    api.editJobs(model.id).then(setJobs).catch(() => {});
  }, [model.id]);
  const loadMusic = useCallback(() => {
    api.editMusic(model.id).then(setMusicList).catch(() => {});
  }, [model.id]);

  useEffect(() => {
    api.editOptions().then(setOptions).catch(() => {});
    loadJobs();
    loadMusic();
  }, [loadJobs, loadMusic]);

  const pick = useCallback((path: string) => {
    setSource(path);
    setDuration(0);
    setTrimStart(0);
    setTrimEnd(0);
    setPlayhead(0);
    setPlaying(false);
    setPicking(false);
  }, []);

  useEffect(() => {
    if (handoff && handoff.at !== handled.current) {
      handled.current = handoff.at;
      pick(handoff.path);
    }
  }, [handoff, pick]);

  useLive((event) => {
    if (event.type !== 'edit_job' || event.model !== model.id) return;
    const job = event.data as EditJob;
    setJobs((list) => {
      const rest = list.filter((j) => j.id !== job.id);
      return [job, ...rest].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    });
    if (job.status === 'saved') toast('Reel saved to the Edited folder');
  });

  // ---- preview playback, kept inside the trimmed window ----
  const seek = useCallback((t: number) => {
    const v = videoRef.current;
    if (v) v.currentTime = t;
    if (bgRef.current) bgRef.current.currentTime = t;
    setPlayhead(t);
    setPlaying(false);
    v?.pause();
    bgRef.current?.pause();
  }, []);

  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (playing) {
      v.pause();
      bgRef.current?.pause();
      setPlaying(false);
      return;
    }
    if (v.currentTime < trimStart || v.currentTime >= trimEnd - 0.05) v.currentTime = trimStart;
    v.playbackRate = speed;
    if (bgRef.current) {
      bgRef.current.currentTime = v.currentTime;
      bgRef.current.playbackRate = speed;
      bgRef.current.play().catch(() => {});
    }
    v.play().catch(() => {});
    setPlaying(true);
  }, [playing, trimStart, trimEnd, speed]);

  useEffect(() => {
    if (videoRef.current) videoRef.current.playbackRate = speed;
    if (bgRef.current) bgRef.current.playbackRate = speed;
  }, [speed, source, fill, aspect]);

  function onTimeUpdate() {
    const v = videoRef.current;
    if (!v) return;
    if (playing && v.currentTime >= trimEnd - 0.03) {
      v.currentTime = trimStart;
      if (bgRef.current) bgRef.current.currentTime = trimStart;
    }
    setPlayhead(v.currentTime);
  }

  function addCaption() {
    if (captions.length >= 5) return;
    const c: Caption = { text: '', position: 'bottom', size: 'L', style: 'outline', color: 'white' };
    setCaptions((list) => [...list, c]);
    setActive(captions.length);
  }
  function setCaption(i: number, patch: Partial<Caption>) {
    setCaptions((list) => list.map((cap, j) => (j === i ? { ...cap, ...patch } : cap)));
  }
  function removeCaption(i: number) {
    setCaptions((list) => list.filter((_, j) => j !== i));
    setActive((a) => Math.max(0, a >= i ? a - 1 : a));
  }

  async function onMusicFile(file: File) {
    try {
      const saved = await uploadMusic(model.id, file);
      loadMusic();
      setMusic(saved.name);
      toast(`Added ${saved.name}`);
    } catch (err) {
      toast((err as Error).message);
    }
  }

  async function make() {
    setBusy(true);
    setError(null);
    try {
      const job = await api.createEdit(model.id, {
        source,
        trimStart,
        trimEnd: trimEnd || duration,
        aspect,
        fill,
        mirror,
        speed,
        captions: captions.filter((c) => c.text.trim()),
        music,
        musicVolume,
        keepOriginalAudio,
        fade,
      });
      setJobs((list) => [job, ...list.filter((j) => j.id !== job.id)]);
      toast('Making your reel…');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const colors = options?.captionColors ?? [];
  const aspectWh = aspect === 'original' ? natural : ASPECT_WH[aspect] ?? [9, 16];
  const showBlur = aspect !== 'original' && fill === 'blur';
  const objectFit: CSSProperties['objectFit'] = aspect === 'original' || showBlur ? 'contain' : 'cover';
  const mirrorStyle: CSSProperties = mirror ? { transform: 'scaleX(-1)' } : {};
  const filmstrip = source ? api.editFilmstrip(model.id, source) : null;
  const outLength = (trimEnd - trimStart) / speed;
  const videoUrl = source ? api.libraryFile(model.id, source) : '';

  return (
    <div>
      <div className="card-head">
        <h1>Editor · {model.name}</h1>
        {source && <span className="muted small">Reel out · {clock(outLength)} · {aspect === 'original' ? 'original' : aspect}</span>}
      </div>

      {picking && (
        <LibraryPicker
          model={model}
          kinds={['found', 'generated', 'edited', 'references']}
          title="Pick a clip to edit"
          videosOnly
          onPick={(item: LibraryItem) => pick(item.path)}
          onClose={() => setPicking(false)}
        />
      )}

      {!source ? (
        <section className="card stack">
          <div className="empty">
            <p>Pick a video of {model.name} — a Reel Finder find, an AI Studio video, or a clip in the library.</p>
            <button className="btn primary" onClick={() => setPicking(true)}>
              Choose a clip
            </button>
          </div>
        </section>
      ) : (
        <div className="edit-grid">
          {/* ---------- left: the live reel + trim bar ---------- */}
          <div className="edit-preview">
            <div className="edit-stage" style={{ aspectRatio: `${aspectWh[0]} / ${aspectWh[1]}` }}>
              {showBlur && (
                <video
                  ref={bgRef}
                  key={`bg-${source}`}
                  className="stage-blur"
                  src={videoUrl}
                  muted
                  playsInline
                  preload="auto"
                  style={mirrorStyle}
                />
              )}
              <video
                ref={videoRef}
                key={source}
                className="stage-video"
                src={videoUrl}
                playsInline
                preload="auto"
                style={{ objectFit, ...mirrorStyle }}
                onLoadedMetadata={(e) => {
                  const v = e.target as HTMLVideoElement;
                  const d = v.duration || 0;
                  setDuration(d);
                  setTrimEnd(d);
                  if (v.videoWidth && v.videoHeight) setNatural([v.videoWidth, v.videoHeight]);
                }}
                onTimeUpdate={onTimeUpdate}
                onEnded={() => seek(trimStart)}
                onClick={togglePlay}
              />
              <CaptionLayer captions={captions} colors={colors} />
              <button
                type="button"
                className={`stage-play${playing ? ' playing' : ''}`}
                onClick={togglePlay}
                aria-label={playing ? 'Pause' : 'Play the trimmed part'}
              >
                {playing ? '❚❚' : '►'}
              </button>
            </div>

            {duration > 0 && (
              <TrimBar
                duration={duration}
                start={trimStart}
                end={trimEnd}
                playhead={playhead}
                filmstrip={filmstrip}
                onTrim={(s, e) => {
                  setTrimStart(s);
                  setTrimEnd(e);
                }}
                onScrub={seek}
              />
            )}

            <div className="row edit-preview-actions">
              <button className="btn small" onClick={() => setPicking(true)}>
                Change clip
              </button>
              <span className="spacer" />
              <span className="muted small">Drag the yellow handles to cut. Tap the frame to play the cut.</span>
            </div>
          </div>

          {/* ---------- right: the controls ---------- */}
          <div className="edit-controls stack">
            <section className="card stack">
              <strong className="small">Shape</strong>
              <div className="chip-row">
                {(options?.aspects ?? [{ id: '9:16', name: '9:16' }]).map((a) => (
                  <button
                    key={a.id}
                    type="button"
                    className={`choice${aspect === a.id ? ' on' : ''}`}
                    onClick={() => setAspect(a.id)}
                    title={a.name}
                  >
                    {a.id === 'original' ? 'Original' : a.id}
                  </button>
                ))}
              </div>
              {aspect !== 'original' && (
                <div className="chip-row">
                  <button type="button" className={`choice${fill === 'crop' ? ' on' : ''}`} onClick={() => setFill('crop')}>
                    Fill (crop edges)
                  </button>
                  <button type="button" className={`choice${fill === 'blur' ? ' on' : ''}`} onClick={() => setFill('blur')}>
                    Fit (blurred edges)
                  </button>
                </div>
              )}
              <label className="check small">
                <input type="checkbox" checked={mirror} onChange={(e) => setMirror(e.target.checked)} />
                <span>Mirror (flip left–right)</span>
              </label>
            </section>

            <section className="card stack">
              <strong className="small">Speed</strong>
              <div className="chip-row">
                {(options?.speeds ?? [0.5, 1, 1.5, 2]).map((s) => (
                  <button key={s} type="button" className={`choice${speed === s ? ' on' : ''}`} onClick={() => setSpeed(s)}>
                    {s === 1 ? '1× normal' : `${s}×`}
                  </button>
                ))}
              </div>
            </section>

            <section className="card stack">
              <div className="row">
                <strong className="small">Captions</strong>
                {captions.length < 5 && (
                  <button className="btn small" onClick={addCaption}>
                    + Add caption
                  </button>
                )}
              </div>
              {captions.length === 0 && (
                <p className="muted small" style={{ margin: 0 }}>
                  Optional. Add text on the reel — you'll see it on the preview as you type.
                </p>
              )}
              {captions.map((cap, i) => (
                <div key={i} className={`caption-edit${active === i ? ' on' : ''}`} onFocusCapture={() => setActive(i)}>
                  <textarea
                    rows={2}
                    placeholder="Type the caption…"
                    value={cap.text}
                    onChange={(e) => setCaption(i, { text: e.target.value })}
                  />
                  <div className="chip-row">
                    {(options?.captionPositions ?? ['top', 'middle', 'bottom']).map((p) => (
                      <button
                        key={p}
                        type="button"
                        className={`choice sm${cap.position === p ? ' on' : ''}`}
                        onClick={() => setCaption(i, { position: p })}
                      >
                        {p}
                      </button>
                    ))}
                  </div>
                  <div className="chip-row">
                    {(options?.captionSizes ?? ['S', 'M', 'L', 'XL']).map((s) => (
                      <button
                        key={s}
                        type="button"
                        className={`choice sm${cap.size === s ? ' on' : ''}`}
                        onClick={() => setCaption(i, { size: s })}
                      >
                        {SIZE_LABEL[s] ?? s}
                      </button>
                    ))}
                  </div>
                  <div className="chip-row">
                    {(options?.captionStyles ?? ['outline', 'box', 'plain']).map((st) => (
                      <button
                        key={st}
                        type="button"
                        className={`choice sm${cap.style === st ? ' on' : ''}`}
                        onClick={() => setCaption(i, { style: st })}
                      >
                        {STYLE_LABEL[st] ?? st}
                      </button>
                    ))}
                  </div>
                  <div className="row caption-colors">
                    {colors.map((c) => (
                      <button
                        key={c.id}
                        type="button"
                        className={`swatch${cap.color === c.id ? ' on' : ''}`}
                        style={{ background: `rgb(${c.rgb.join(',')})` }}
                        aria-label={c.id}
                        onClick={() => setCaption(i, { color: c.id })}
                      />
                    ))}
                    <span className="spacer" />
                    <button className="btn link small" onClick={() => removeCaption(i)}>
                      Remove
                    </button>
                  </div>
                </div>
              ))}
            </section>

            <section className="card stack">
              <strong className="small">Music & sound</strong>
              <div className="row">
                <select value={music} onChange={(e) => setMusic(e.target.value)} style={{ flex: 1 }}>
                  <option value="">No added music</option>
                  {musicList.map((t) => (
                    <option key={t.name} value={t.name}>
                      {t.name}
                    </option>
                  ))}
                </select>
                <label className="btn small">
                  Add track
                  <input
                    type="file"
                    accept="audio/*"
                    style={{ display: 'none' }}
                    onChange={(e) => e.target.files?.[0] && onMusicFile(e.target.files[0])}
                  />
                </label>
              </div>
              {music && (
                <>
                  <label className="field">
                    <span className="small">Music volume: {Math.round(musicVolume * 100)}%</span>
                    <input type="range" min={0} max={1.5} step={0.05} value={musicVolume} onChange={(e) => setMusicVolume(+e.target.value)} />
                  </label>
                  <label className="check small">
                    <input type="checkbox" checked={keepOriginalAudio} onChange={(e) => setKeepOriginalAudio(e.target.checked)} />
                    <span>Keep the clip's own sound under the music</span>
                  </label>
                </>
              )}
              <label className="check small">
                <input type="checkbox" checked={fade} onChange={(e) => setFade(e.target.checked)} />
                <span>Fade in and out</span>
              </label>
              <p className="muted small" style={{ margin: 0 }}>
                Use music you have the rights to — Instagram and TikTok also have in-app music you can add after posting.
              </p>
            </section>

            {error && <div className="notice error small">{error}</div>}
            <button className="btn primary big" disabled={busy} onClick={make}>
              {busy ? 'Starting…' : `Make the reel · ${clock(outLength)}`}
            </button>
          </div>
        </div>
      )}

      <section className="card" style={{ marginTop: 16 }}>
        <h2>{model.name}'s reels</h2>
        {jobs.length === 0 ? (
          <p className="muted small">What you make here lands in the Edited folder and shows up below and in the library.</p>
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
                  <div className="account-name">{job.name}</div>
                  <div className="account-meta">
                    {STATUS_LABEL[job.status] ?? job.status}
                    {job.status === 'processing' && ` · ${job.progress}%`}
                  </div>
                  {job.error && <div className="batch-error">{job.error}</div>}
                </div>
                <div className="account-side stack">
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

      <p className="muted small">
        Everything here runs on your Mac with ffmpeg — free, no account.{' '}
        <button type="button" className="btn link small" onClick={onSettings}>
          Model folders
        </button>
      </p>
    </div>
  );
}
