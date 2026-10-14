import { useCallback, useEffect, useRef, useState } from 'react';
import type { EditJob, LibraryItem, Model } from '../types';
import type { Handoff } from '../App';
import { api, uploadMusic } from '../api';
import { useLive } from '../live';
import { LibraryPicker } from '../components/LibraryPicker';

type Caption = { text: string; position: string; size: string };
type Aspect = { id: string; name: string };

const STATUS_LABEL: Record<string, string> = {
  starting: 'Getting ready',
  processing: 'Building',
  saved: 'Done',
  failed: 'Failed',
};

function fmt(s: number) {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

// The Editor: take a clip, trim it, crop it to shape, add music and captions, and save a ready reel.
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
  const [aspects, setAspects] = useState<Aspect[]>([]);
  const [source, setSource] = useState<string | null>(null);
  const [duration, setDuration] = useState(0);
  const [trimStart, setTrimStart] = useState(0);
  const [trimEnd, setTrimEnd] = useState(0);
  const [aspect, setAspect] = useState('9:16');
  const [captions, setCaptions] = useState<Caption[]>([]);
  const [music, setMusic] = useState('');
  const [musicList, setMusicList] = useState<{ name: string }[]>([]);
  const [musicVolume, setMusicVolume] = useState(0.8);
  const [keepOriginalAudio, setKeepOriginalAudio] = useState(true);
  const [fade, setFade] = useState(true);
  const [picking, setPicking] = useState(false);
  const [jobs, setJobs] = useState<EditJob[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const handled = useRef(0);

  const loadJobs = useCallback(() => {
    api.editJobs(model.id).then(setJobs).catch(() => {});
  }, [model.id]);
  const loadMusic = useCallback(() => {
    api.editMusic(model.id).then(setMusicList).catch(() => {});
  }, [model.id]);

  useEffect(() => {
    api.editOptions().then((o) => setAspects(o.aspects)).catch(() => {});
    loadJobs();
    loadMusic();
  }, [loadJobs, loadMusic]);

  const pick = useCallback((path: string) => {
    setSource(path);
    setDuration(0);
    setTrimStart(0);
    setTrimEnd(0);
    setPicking(false);
  }, []);

  // A clip sent here from the library, Reel Finder or AI Studio.
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

  function addCaption() {
    if (captions.length < 4) setCaptions((c) => [...c, { text: '', position: 'bottom', size: 'M' }]);
  }
  function setCaption(i: number, patch: Partial<Caption>) {
    setCaptions((c) => c.map((cap, j) => (j === i ? { ...cap, ...patch } : cap)));
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

  return (
    <div>
      <div className="card-head">
        <h1>Editor · {model.name}</h1>
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

      <section className="card stack">
        <div className="row">
          <strong>1. Clip</strong>
          <button className="btn small" onClick={() => setPicking(true)}>
            {source ? 'Choose another' : 'Choose a clip'}
          </button>
        </div>
        {source ? (
          <video
            key={source}
            className="edit-preview"
            src={api.libraryFile(model.id, source)}
            controls
            onLoadedMetadata={(e) => {
              const d = (e.target as HTMLVideoElement).duration || 0;
              setDuration(d);
              if (!trimEnd) setTrimEnd(d);
            }}
          />
        ) : (
          <div className="empty">
            <p>Pick a video from this model — a Reel Finder find, an AI Studio video, or an edited reel.</p>
          </div>
        )}
      </section>

      {source && (
        <>
          <section className="card stack">
            <strong>2. Trim</strong>
            {duration === 0 ? (
              <p className="muted small" style={{ margin: 0 }}>
                Reading the clip… if trimming doesn't appear, the whole clip is used.
              </p>
            ) : (
              <>
                <div className="row2">
                  <label className="field">
                    <span className="small">Start: {fmt(trimStart)}</span>
                    <input
                      type="range"
                      min={0}
                      max={Math.max(0, duration - 0.3)}
                      step={0.1}
                      value={trimStart}
                      onChange={(e) => setTrimStart(Math.min(+e.target.value, trimEnd - 0.3))}
                    />
                  </label>
                  <label className="field">
                    <span className="small">End: {fmt(trimEnd)}</span>
                    <input
                      type="range"
                      min={0.3}
                      max={duration}
                      step={0.1}
                      value={trimEnd}
                      onChange={(e) => setTrimEnd(Math.max(+e.target.value, trimStart + 0.3))}
                    />
                  </label>
                </div>
                <p className="muted small" style={{ margin: 0 }}>
                  Keeping {fmt(trimEnd - trimStart)} of {fmt(duration)}.
                </p>
              </>
            )}
          </section>

          <section className="card stack">
            <strong>3. Shape</strong>
            <select value={aspect} onChange={(e) => setAspect(e.target.value)}>
              {(aspects.length ? aspects : [{ id: '9:16', name: '9:16' }]).map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </section>

          <section className="card stack">
            <div className="row">
              <strong>4. Captions</strong>
              {captions.length < 4 && (
                <button className="btn small" onClick={addCaption}>
                  + Add caption
                </button>
              )}
            </div>
            {captions.length === 0 && <p className="muted small" style={{ margin: 0 }}>Optional — add text on top of the video.</p>}
            {captions.map((cap, i) => (
              <div key={i} className="caption-row stack">
                <textarea
                  rows={2}
                  placeholder="Caption text"
                  value={cap.text}
                  onChange={(e) => setCaption(i, { text: e.target.value })}
                />
                <div className="row">
                  <select value={cap.position} onChange={(e) => setCaption(i, { position: e.target.value })}>
                    <option value="top">Top</option>
                    <option value="middle">Middle</option>
                    <option value="bottom">Bottom</option>
                  </select>
                  <select value={cap.size} onChange={(e) => setCaption(i, { size: e.target.value })}>
                    <option value="S">Small</option>
                    <option value="M">Medium</option>
                    <option value="L">Large</option>
                  </select>
                  <button className="btn link small" onClick={() => setCaptions((c) => c.filter((_, j) => j !== i))}>
                    Remove
                  </button>
                </div>
              </div>
            ))}
          </section>

          <section className="card stack">
            <strong>5. Music</strong>
            <div className="row">
              <select value={music} onChange={(e) => setMusic(e.target.value)}>
                <option value="">No music</option>
                {musicList.map((t) => (
                  <option key={t.name} value={t.name}>
                    {t.name}
                  </option>
                ))}
              </select>
              <label className="btn small">
                Add a track
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
              Use music you have the rights to. Instagram and TikTok also have their own in-app music libraries you can add after posting.
            </p>
          </section>

          {error && <div className="notice error small">{error}</div>}
          <button className="btn primary big" disabled={busy || !source} onClick={make}>
            {busy ? 'Starting…' : 'Make the reel'}
          </button>
        </>
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
