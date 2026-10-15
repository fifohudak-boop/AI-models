import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  Agent, Candidate, HuntProgress, HuntSettings, LogEntry, Model, Reference, ReelPlatform, ReelsStatus, SelfTestState,
} from '../types';
import { api } from '../api';
import { useLive } from '../live';
import { copyText } from '../clipboard';
import { LibraryPicker } from '../components/LibraryPicker';
import { ReferencesPanel } from '../components/reels/References';
import { ActivityLog, AgentsGrid, Feed, ProgressPanel } from '../components/reels/LiveView';
import { PLATFORM_NAMES, RECOMMENDED_MODELS, autoPool } from '../components/reels/common';

const PLATFORMS: { id: ReelPlatform; label: string }[] = [
  { id: 'tiktok', label: 'TikTok' },
  { id: 'instagram', label: 'Instagram Reels' },
  { id: 'pinterest', label: 'Pinterest' },
];
const STEP_ICON: Record<string, string> = { ok: '✓', warn: '!', fail: '✕', skip: '–', pending: '', running: '…' };

function NumberField({
  label,
  value,
  onChange,
  placeholder,
  min = 0,
  max,
  step = 1,
  emptyIsZero = false,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  placeholder?: string;
  min?: number;
  max?: number;
  step?: number;
  emptyIsZero?: boolean;
}) {
  return (
    <label className="field">
      <span className="small">{label}</span>
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        placeholder={placeholder}
        value={emptyIsZero && value === 0 ? '' : value}
        onChange={(e) => onChange(e.target.value === '' ? 0 : Math.max(0, Math.round(+e.target.value)))}
      />
    </label>
  );
}

function SelfTestPanel({ test, onClose, onCopyReport }: { test: SelfTestState; onClose: () => void; onCopyReport: () => void }) {
  const fails = test.steps.filter((s) => s.status === 'fail').length;
  const warns = test.steps.filter((s) => s.status === 'warn').length;
  return (
    <section className="card stack" aria-live="polite">
      <div className="card-head" style={{ marginBottom: 0 }}>
        <h2>
          {PLATFORM_NAMES[test.platform]} self-test · searching “{test.query}”{test.running ? '' : ' · done'}
        </h2>
        <div className="row">
          <button className="btn small" onClick={onCopyReport}>
            Copy report
          </button>
          <button className="btn small" onClick={onClose} aria-label="Close self-test">
            Close
          </button>
        </div>
      </div>
      <ol className="steps">
        {test.steps.map((step) => (
          <li key={step.name} className={`step step-${step.status}`}>
            <span className="step-icon" aria-hidden="true">
              {STEP_ICON[step.status] ?? ''}
            </span>
            <span className="step-name">{step.name}</span>
            <span className="step-detail muted small">{step.status === 'pending' ? 'Waiting…' : step.detail}</span>
          </li>
        ))}
      </ol>
      {!test.running && (
        <p className="small muted" style={{ margin: 0 }}>
          {fails
            ? 'Something isn’t working. Click Copy report and paste it into a chat with Claude.'
            : warns
              ? 'It works — see the notes marked “!”.'
              : `Everything works for ${PLATFORM_NAMES[test.platform]} on this Mac.`}
        </p>
      )}
    </section>
  );
}

// Reel Finder, for one model: the same engine as the Reel Finder app, in Fifofarm's look.
export function ReelFinderPage({
  model,
  status,
  onStatus,
  toast,
  onPost,
  onStudio,
  onSettings,
}: {
  model: Model;
  status: ReelsStatus | null;
  onStatus: () => void;
  toast: (m: string) => void;
  onPost: (path: string) => void;
  onStudio: (path: string) => void;
  onSettings: () => void;
}) {
  const [settings, setSettings] = useState<HuntSettings | null>(null);
  const [references, setReferences] = useState<Map<string, Reference>>(new Map());
  const [progress, setProgress] = useState<HuntProgress | null>(null);
  const [agents, setAgents] = useState<Map<number, Agent>>(new Map());
  const [candidates, setCandidates] = useState<Map<string, Candidate>>(new Map());
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [selfTest, setSelfTest] = useState<SelfTestState | null>(null);
  const [showSelfTest, setShowSelfTest] = useState(false);
  const [link, setLink] = useState('');
  const [linkNote, setLinkNote] = useState<string | null>(null);
  const [pullNote, setPullNote] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [picking, setPicking] = useState(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const loadReferences = useCallback(async () => {
    try {
      const list = await api.references(model.id);
      setReferences(new Map(list.map((r) => [r.id, r])));
    } catch {
      // the app is restarting
    }
  }, [model.id]);

  useEffect(() => {
    api
      .huntSettings(model.id)
      .then(setSettings)
      .catch((err) => toast(err.message));
    loadReferences();
  }, [model.id, loadReferences, toast]);

  // Catch up with this model's latest hunt (running or done) — e.g. after looking at another tool.
  // Anything that already arrived live since the page opened is newer, so it wins.
  useEffect(() => {
    let cancelled = false;
    api
      .huntSnapshot(model.id)
      .then(({ hunt, selftests }) => {
        if (cancelled) return;
        if (hunt) {
          setProgress((live) => live ?? hunt.progress);
          setAgents((live) => new Map([...hunt.agents.map((a): [number, Agent] => [a.id, a]), ...live]));
          setCandidates(
            (live) => new Map([...hunt.candidates.map((c): [string, Candidate] => [`${c.platform}:${c.id}`, c]), ...live])
          );
          setLogs((live) => {
            const last = hunt.logs.length ? hunt.logs[hunt.logs.length - 1].t : 0;
            return [...hunt.logs, ...live.filter((l) => l.t > last)].slice(-300);
          });
        }
        const latest = selftests.find((t) => t.running) ?? null;
        if (latest) setSelfTest((live) => live ?? latest);
      })
      .catch(() => {
        // the app is restarting; the live connection catches up when it's back
      });
    return () => {
      cancelled = true;
    };
  }, [model.id]);

  // Changes are saved as you type (per model).
  const update = useCallback(
    (patch: Partial<HuntSettings>) => {
      setSettings((prev) => {
        if (!prev) return prev;
        const next = { ...prev, ...patch };
        clearTimeout(saveTimer.current);
        saveTimer.current = setTimeout(() => {
          api.saveHuntSettings(model.id, next).catch((err) => toast(err.message));
        }, 500);
        return next;
      });
    },
    [model.id, toast]
  );

  const resetLive = useCallback(() => {
    setProgress(null);
    setAgents(new Map());
    setCandidates(new Map());
    setLogs([]);
  }, []);

  useLive((event) => {
    const mine = event.model === model.id;
    switch (event.type) {
      case 'connected':
        loadReferences();
        break;
      case 'snapshot': {
        if (!mine) break;
        const snap = event.data as {
          progress: HuntProgress;
          agents: Agent[];
          candidates: Candidate[];
          logs: LogEntry[];
        } | null;
        if (!snap) break;
        setProgress(snap.progress);
        setAgents(new Map(snap.agents.map((a) => [a.id, a])));
        setCandidates(new Map(snap.candidates.map((c) => [`${c.platform}:${c.id}`, c])));
        setLogs(snap.logs);
        break;
      }
      case 'progress':
        if (mine) setProgress(event.data as HuntProgress);
        break;
      case 'agent':
        if (mine) {
          const a = event.data as Agent;
          setAgents((prev) => new Map(prev).set(a.id, a));
        }
        break;
      case 'candidate':
        if (mine) {
          const c = event.data as Candidate;
          setCandidates((prev) => new Map(prev).set(`${c.platform}:${c.id}`, c));
        }
        break;
      case 'log':
        if (mine) {
          const entry = event.data as LogEntry;
          setLogs((prev) => [...prev.slice(-299), entry]);
          if (entry.level === 'warn') toast(entry.text);
        }
        break;
      case 'finished':
        if (mine) {
          const p = event.data as HuntProgress;
          setProgress(p);
          setFinishing(false);
          toast(`${p.finished_reason}.`);
        }
        onStatus();
        break;
      case 'selftest':
        setSelfTest(event.data as SelfTestState);
        if ((event.data as SelfTestState).running === false) onStatus();
        break;
      case 'link':
        if (mine) {
          const d = event.data as { status: string; summary?: string; error?: string };
          if (d.status === 'working') setLinkNote('Saving…');
          else if (d.status === 'done') {
            setLinkNote(`✓ Saved: ${d.summary}. In “Saved links” (Library → Found videos).`);
            setLink('');
            toast('Video saved to the library.');
          } else setLinkNote(`Couldn't save it: ${d.error}`);
        }
        break;
      case 'reference':
        if (mine) {
          const r = event.data as Reference;
          setReferences((prev) => new Map(prev).set(r.id, r));
        }
        break;
      case 'reference_removed':
        if (mine) {
          const { id } = event.data as { id: string };
          setReferences((prev) => {
            const next = new Map(prev);
            next.delete(id);
            return next;
          });
        }
        break;
      case 'model_pull': {
        const d = event.data as { model: string; error?: string; done?: boolean; percent?: number | null; status?: string };
        if (d.error) {
          toast(d.error);
          setPullNote(null);
          onStatus();
        } else if (d.done) {
          toast(`${d.model} is ready.`);
          setPullNote(null);
          onStatus();
        } else setPullNote(`Downloading ${d.model}: ${d.percent ?? '…'}${d.percent != null ? '%' : ''} ${d.status || ''}`);
        break;
      }
    }
  });

  const huntingHere = !!status?.hunting && status.huntModel === model.id;
  const huntingElsewhere = !!status?.hunting && status.huntModel !== model.id;
  const running = (progress?.running ?? false) || huntingHere;
  const testing = !!status?.testing || !!selfTest?.running;

  async function start() {
    if (!settings) return;
    if (running) {
      // First press: stop searching and save the best found so far. Second press: stop everything.
      try {
        if (!finishing) {
          setFinishing(true);
          await api.finishHunt();
        } else await api.stopHunt();
      } catch (err) {
        toast((err as Error).message);
      }
      return;
    }
    setStarting(true);
    try {
      resetLive();
      clearTimeout(saveTimer.current);
      await api.startHunt(model.id, settings);
      onStatus();
    } catch (err) {
      toast((err as Error).message);
    } finally {
      setStarting(false);
    }
  }

  async function copyReport() {
    try {
      const text = await (await fetch(api.reportUrl)).text();
      if (await copyText(text)) toast('Report copied — paste it into a chat with Claude.');
      else window.open(api.reportUrl, '_blank');
    } catch (err) {
      toast(`Couldn't build the report: ${(err as Error).message}`);
    }
  }

  const ollama = status?.ollama;
  const modelNames = useMemo(() => {
    const installed = ollama?.models ?? [];
    const names = new Set(installed.map((m) => m.name));
    const list = installed.map((m) => ({ value: m.name, label: `${m.name}${m.vision ? ' · sees images' : ' · text only'}` }));
    for (const r of RECOMMENDED_MODELS) if (!names.has(r.name)) list.push({ value: r.name, label: `${r.name} · not installed` });
    if (settings?.model && !list.some((o) => o.value === settings.model)) {
      list.push({ value: settings.model, label: `${settings.model} · not installed` });
    }
    return list;
  }, [ollama?.models, settings?.model]);
  const chosenInstalled = !!settings && (ollama?.models ?? []).some((m) => m.name === settings.model || m.name === `${settings.model}:latest`);
  const chosen = (ollama?.models ?? []).find((m) => m.name === settings?.model || m.name === `${settings?.model}:latest`);
  const refsList = [...references.values()];
  const readyRefs = refsList.some((r) => r.status === 'ready');
  const allCandidates = useMemo(() => [...candidates.values()], [candidates]);
  const agentList = useMemo(() => [...agents.values()].sort((a, b) => a.id - b.id), [agents]);
  const anyLogin = status ? Object.values(status.logins).some(Boolean) : true;

  async function importLogins() {
    try {
      await api.importLogins();
      toast('Logins copied from Reel Finder');
      onStatus();
    } catch (err) {
      toast((err as Error).message);
    }
  }

  if (!settings) return <p className="muted">Loading…</p>;

  const pills = (
    <div className="pills">
      {!ollama ? null : !ollama.running ? (
        <span className="chip draft" title="Start Ollama to let the AI judge videos">
          AI off — keyword mode
        </span>
      ) : !chosenInstalled ? (
        <span className="chip draft">AI model missing</span>
      ) : (
        <span className="chip published">AI: {settings.model}</span>
      )}
      {status && (status.ffmpeg ? <span className="chip published">ffmpeg</span> : <span className="chip failed">ffmpeg missing</span>)}
      {status &&
        (!status.similarity.installed ? (
          <span className="chip draft">Look-matching off</span>
        ) : status.similarity.error ? (
          <span className="chip draft" title={status.similarity.error}>
            Look-matching off
          </span>
        ) : (
          <span className="chip published">Look-matching</span>
        ))}
    </div>
  );

  return (
    <div>
      <div className="card-head">
        <h1>Reel Finder · {model.name}</h1>
        {pills}
      </div>
      {huntingElsewhere && (
        <div className="notice info small" style={{ marginBottom: 12 }}>
          Another model's hunt is running — one hunt at a time (they share the agents' browser). You can set this one up
          meanwhile.
        </div>
      )}
      {status && !anyLogin && !running && (
        <div className="notice warn" style={{ marginBottom: 12 }}>
          <strong>Log in before you hunt.</strong> The agents can only search platforms you're signed into — without a
          login they land on the sign-in page and find nothing. In <b>Where to search</b> below, press <b>Connect</b> next
          to a platform, log in, then close that window.
          {status.canImportLogins && (
            <>
              {' '}
              Already signed in in the Reel Finder app?{' '}
              <button type="button" className="btn small" onClick={importLogins}>
                Copy those logins
              </button>
            </>
          )}
        </div>
      )}
      {picking && (
        <LibraryPicker
          model={model}
          kinds={['references', 'found', 'generated']}
          title={`Use as a reference — ${model.name}'s folders`}
          onPick={async (item) => {
            setPicking(false);
            try {
              const ref = await api.addReferenceLocal(model.id, item.path);
              setReferences((prev) => (prev.has(ref.id) ? prev : new Map(prev).set(ref.id, ref)));
            } catch (err) {
              toast((err as Error).message);
            }
          }}
          onClose={() => setPicking(false)}
        />
      )}
      <div className="reels-layout">
        <form
          className="reels-options"
          autoComplete="off"
          onSubmit={(e) => {
            e.preventDefault();
            start();
          }}
        >
          <ReferencesPanel
            model={model}
            references={references}
            setReferences={setReferences}
            closeness={settings.closeness}
            onCloseness={(v) => update({ closeness: v })}
            onFromLibrary={() => setPicking(true)}
            toast={toast}
          />

          <section className="card stack">
            <label className="field">
              <span>{refsList.length ? 'Anything to add? (optional)' : 'What are you looking for?'}</span>
              <textarea
                rows={4}
                value={settings.description}
                onChange={(e) => update({ description: e.target.value })}
                placeholder={
                  refsList.length
                    ? 'e.g. only night shots, no talking — or leave empty and let the reference speak'
                    : 'e.g. Cinematic slow-motion car drifts at night with smoke, no talking, filmed from low angles'
                }
              />
            </label>
            <div className="row2">
              <label className="field">
                <span className="small" title="Videos must mention at least one of these">
                  Keywords / hashtags
                </span>
                <input value={settings.keywords} placeholder="#cardrift, night drift" onChange={(e) => update({ keywords: e.target.value })} />
              </label>
              <label className="field">
                <span className="small">Skip videos mentioning</span>
                <input value={settings.exclude} placeholder="giveaway, tutorial" onChange={(e) => update({ exclude: e.target.value })} />
              </label>
            </div>
          </section>

          <section className="card stack">
            <h2>Where to search</h2>
            {PLATFORMS.map((p) => {
              const on = settings.platforms.includes(p.id);
              const loggedIn = !!status?.logins?.[p.id];
              return (
                <div key={p.id} className="reel-platform">
                  <label className="check" style={{ flex: 1 }}>
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={(e) =>
                        update({
                          platforms: e.target.checked
                            ? [...settings.platforms, p.id]
                            : settings.platforms.filter((x) => x !== p.id),
                        })
                      }
                    />
                    <span>{p.label}</span>
                  </label>
                  <button
                    type="button"
                    className="btn small"
                    disabled={running || testing}
                    title="Run one quick real search and check every step"
                    onClick={async () => {
                      try {
                        const { query } = await api.selfTest(p.id, settings);
                        setSelfTest({ platform: p.id, query, running: true, steps: [] });
                        setShowSelfTest(true);
                        onStatus();
                      } catch (err) {
                        toast((err as Error).message);
                      }
                    }}
                  >
                    Test
                  </button>
                  <button
                    type="button"
                    className={`btn small${loggedIn ? ' connected' : ''}`}
                    onClick={async () => {
                      try {
                        await api.reelsLogin(p.id);
                        toast(`Log in to ${PLATFORM_NAMES[p.id]} in the window that opened, then come back here.`);
                        setTimeout(onStatus, 4000);
                      } catch (err) {
                        toast((err as Error).message);
                      }
                    }}
                  >
                    {loggedIn ? 'Connected ✓' : 'Connect'}
                  </button>
                </div>
              );
            })}
            <label className="check small">
              <input type="checkbox" checked={settings.include_images} onChange={(e) => update({ include_images: e.target.checked })} />
              <span>Pinterest: also save reference images (not just videos)</span>
            </label>
            <p className="muted small" style={{ margin: 0 }}>
              Connect opens the agents' browser so you can log in once (shared by all models). A spare account is safest.
              Test runs one quick real search to check everything works.
            </p>
            {status?.canImportLogins && !anyLogin && (
              <div className="notice info small row">
                <span>Logged in to these in the Reel Finder app? Copy those logins over instead of logging in again.</span>
                <button type="button" className="btn small" onClick={importLogins}>
                  Copy logins from Reel Finder
                </button>
              </div>
            )}
          </section>

          <section className="card stack">
            <div className="row2">
              <NumberField label="Videos to save" value={settings.target_count} min={1} max={500} onChange={(v) => update({ target_count: Math.max(1, v) })} />
              <NumberField
                label="Videos to look at"
                value={settings.pool_size}
                max={2000}
                step={10}
                emptyIsZero
                placeholder={`auto (${autoPool(settings.target_count || 20)})`}
                onChange={(v) => update({ pool_size: v })}
              />
              <NumberField label="Time limit (min)" value={settings.time_limit_min} min={1} max={240} onChange={(v) => update({ time_limit_min: Math.max(1, v) })} />
              <label className="field">
                <span className="small">AI agents: {settings.agents}</span>
                <input type="range" min={1} max={6} step={1} value={settings.agents} onChange={(e) => update({ agents: +e.target.value })} />
              </label>
            </div>
            <p className="muted small" style={{ margin: 0 }}>
              The agents look at this many videos, the AI scores every one, and the best ones are saved. Empty = 4× what you
              want to save.
            </p>
          </section>

          <details className="card">
            <summary>
              <strong>Filters</strong>
            </summary>
            <div className="row2" style={{ marginTop: 10 }}>
              <NumberField label="Min length (sec)" value={settings.min_duration} emptyIsZero placeholder="0" onChange={(v) => update({ min_duration: v })} />
              <NumberField label="Max length (sec)" value={settings.max_duration} emptyIsZero placeholder="no limit" onChange={(v) => update({ max_duration: v })} />
              <NumberField label="Min views" value={settings.min_views} emptyIsZero step={1000} placeholder="0" onChange={(v) => update({ min_views: v })} />
              <NumberField label="Min likes" value={settings.min_likes} emptyIsZero step={100} placeholder="0" onChange={(v) => update({ min_likes: v })} />
              <NumberField label="Posted within (days)" value={settings.max_age_days} emptyIsZero placeholder="any time" onChange={(v) => update({ max_age_days: v })} />
            </div>
          </details>

          <details className="card">
            <summary>
              <strong>AI</strong>
            </summary>
            <div className="stack" style={{ marginTop: 10 }}>
              <label className="field">
                <span className="small">Model (runs on your Mac with Ollama)</span>
                <div className="row" style={{ flexWrap: 'nowrap' }}>
                  <select value={settings.model} onChange={(e) => update({ model: e.target.value })}>
                    {modelNames.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                  {ollama?.running && !chosenInstalled && (
                    <button
                      type="button"
                      className="btn small"
                      disabled={ollama.pulling || !!pullNote}
                      onClick={async () => {
                        try {
                          await api.pullModel(settings.model);
                          setPullNote(`Downloading ${settings.model}…`);
                        } catch (err) {
                          toast((err as Error).message);
                        }
                      }}
                    >
                      Download
                    </button>
                  )}
                </div>
              </label>
              <p className="muted small" style={{ margin: 0 }}>
                {pullNote ??
                  (!ollama
                    ? ''
                    : !ollama.running
                      ? "Ollama isn't running. Quit and reopen Fifofarm Ultimate; it starts Ollama for you. Until then, videos are matched by keywords."
                      : !chosenInstalled
                        ? `Press Download to install this model (one time).${RECOMMENDED_MODELS.find((r) => r.name === settings.model) ? ` ${settings.model}: ${RECOMMENDED_MODELS.find((r) => r.name === settings.model)!.note}.` : ''}`
                        : chosen && !chosen.vision
                          ? "This model can't see thumbnails, so it judges captions only."
                          : '')}
              </p>
              <label className="field">
                <span className="small">Minimum AI score: {settings.min_score || 'off'}</span>
                <input type="range" min={0} max={90} step={5} value={settings.min_score} onChange={(e) => update({ min_score: +e.target.value })} />
                <span className="scale small muted">
                  <span>0 = always save the number I asked for</span>
                  <span>Only near-perfect</span>
                </span>
              </label>
              <label className="check small">
                <input type="checkbox" checked={settings.watch_check} onChange={(e) => update({ watch_check: e.target.checked })} />
                <span>Watch-check: AI looks at frames after downloading and deletes misses</span>
              </label>
            </div>
          </details>

          <section className="card stack">
            <h2>Saving</h2>
            <p className="small" style={{ margin: 0 }}>
              To {model.name}'s <strong>Found videos</strong>: <span className="mono">{settings.output_dir}</span>{' '}
              <button type="button" className="btn link small" onClick={onSettings}>
                Change
              </button>
            </p>
            <label className="check small">
              <input type="checkbox" checked={settings.subfolder_per_hunt} onChange={(e) => update({ subfolder_per_hunt: e.target.checked })} />
              <span>New subfolder for every hunt</span>
            </label>
            <label className="check small">
              <input type="checkbox" checked={settings.show_browser} onChange={(e) => update({ show_browser: e.target.checked })} />
              <span>Show the agents scrolling (otherwise they run hidden)</span>
            </label>
          </section>

          <section className="card stack">
            <h2>Save a video from a link</h2>
            <div className="row" style={{ flexWrap: 'nowrap' }}>
              <input
                type="url"
                placeholder="https://www.tiktok.com/@…/video/…"
                spellCheck={false}
                value={link}
                onChange={(e) => setLink(e.target.value)}
                aria-label="Video link"
              />
              <button
                type="button"
                className="btn small"
                onClick={async () => {
                  if (!link.trim()) return;
                  setLinkNote('Saving…');
                  try {
                    await api.saveLink(model.id, link.trim());
                  } catch (err) {
                    setLinkNote((err as Error).message);
                  }
                }}
              >
                Save
              </button>
            </div>
            <p className="muted small" style={{ margin: 0 }}>
              {linkNote ?? 'Any TikTok, Instagram, Pinterest or YouTube video. Saved as an MP4 in “Saved links” inside Found videos.'}
            </p>
          </section>

          <div className="reels-actions">
            <button type="submit" className="btn primary big" disabled={starting || (testing && !running) || (huntingElsewhere && !running)}>
              {starting ? 'Starting…' : running ? (finishing ? 'Stop now' : 'Finish now') : 'Start hunt'}
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => api.openFolder(progress?.folder || settings.output_dir).catch((err) => toast(err.message))}
            >
              Open folder
            </button>
          </div>
        </form>

        <div className="reels-live">
          {selfTest && showSelfTest && (
            <SelfTestPanel test={selfTest} onClose={() => setShowSelfTest(false)} onCopyReport={copyReport} />
          )}
          <ProgressPanel
            progress={progress}
            idleText={
              readyRefs
                ? 'Press Start hunt to find videos that look like your reference.'
                : 'Drop a reference video or describe what you need, then press Start hunt.'
            }
          />
          <AgentsGrid agents={agentList} />
          <Feed
            modelId={model.id}
            candidates={allCandidates}
            usesReference={!!progress?.matching_looks}
            onPost={onPost}
            onStudio={onStudio}
            onMoreLike={async (c) => {
              try {
                // A saved find is used straight from the folder; otherwise it's fetched from its link.
                const ref =
                  c.status === 'downloaded' && c.file
                    ? await api.addReferenceLocal(model.id, c.file)
                    : await api.addReferenceLink(model.id, c.url);
                setReferences((prev) => (prev.has(ref.id) ? prev : new Map(prev).set(ref.id, ref)));
                toast(running ? 'Added as a reference for your next hunt.' : 'Added as a reference — press Start hunt to find more like it.');
              } catch (err) {
                toast((err as Error).message);
              }
            }}
            empty={
              <div className="how-it-works small">
                <h2>How it works</h2>
                <ol>
                  <li>
                    <b>Connect</b> TikTok, Instagram and Pinterest once (left). Log in, then close that window.
                  </li>
                  <li>
                    <b>Add a reference video</b> — one that looks like what you want for {model.name} — or describe the
                    videos in plain words. Both together work best.
                  </li>
                  <li>
                    Press <b>Start hunt</b>. The agents look at lots of videos, every one is scored on how much it looks like
                    your reference, and the best ones are saved to {model.name}'s Found videos.
                  </li>
                  <li>
                    Then <b>Post</b> a find with Fifofarm, or send it to <b>AI Studio</b> to make it with {model.name}.
                  </li>
                </ol>
              </div>
            }
          />
          <ActivityLog logs={logs} onCopyReport={copyReport} onOpenLog={() => api.openLog().catch((err) => toast(err.message))} />
        </div>
      </div>
    </div>
  );
}
