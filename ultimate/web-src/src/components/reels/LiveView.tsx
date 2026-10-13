import { useState } from 'react';
import type { Agent, Candidate, HuntProgress, LogEntry } from '../../types';
import { api } from '../../api';
import {
  AGENT_STATE, BEST_STATES, PHASE_TEXT, PLATFORM_BADGE, PLATFORM_NAMES, STATUS_TEXT, fmtNumber, fmtTime,
} from './common';

type Filter = 'best' | 'downloaded' | 'all' | 'rejected';

export function ProgressPanel({ progress, idleText }: { progress: HuntProgress | null; idleText: string }) {
  const p = progress;
  const pct = p && p.target ? Math.min(100, (100 * p.downloaded) / p.target) : 0;
  let headline = 'Ready when you are';
  let subline = idleText;
  if (p?.running) {
    headline = PHASE_TEXT[p.phase] || 'Hunting…';
    if (p.phase === 'searching') headline += ` — ${p.looked_at} of ${p.pool_target}`;
    if (p.phase === 'checking') headline += ` — ${p.queued} to go${p.quick ? ' (from captions)' : ''}`;
    if (p.finishing) headline = `Finishing up — ${headline.toLowerCase()}`;
    const how = p.matching_looks
      ? ` · matching ${p.references > 1 ? `${p.references} references` : 'your reference'} (${p.closeness.toLowerCase()})`
      : '';
    subline = `${p.folder}${p.brain ? ` · scored by ${p.brain}` : ''}${how}`;
  } else if (p?.finished_reason) {
    headline = p.finished_reason;
    subline = p.folder;
  }
  const stats: [string, string | number][] = p
    ? [
        ['Looked at', `${p.looked_at ?? 0} / ${p.pool_target ?? '–'}`],
        ['Scored', p.scored ?? 0],
        ['Waiting for AI', p.queued],
        ['Saving', p.downloading],
        ['Skipped by filters', p.skipped ?? 0],
        ['Replaced', p.failed],
        ['Already had', p.already_have],
        ['Time', fmtTime(p.elapsed)],
      ]
    : [];
  return (
    <section className="card hunt-progress">
      <div className="row" style={{ flexWrap: 'nowrap', alignItems: 'flex-start' }}>
        <div className="big-count">
          {p?.downloaded ?? 0}
          <span className="of"> / {p?.target ?? 0}</span>
        </div>
        <div style={{ minWidth: 0 }}>
          <div className="hunt-headline">{headline}</div>
          <div className="muted small hunt-subline">{subline}</div>
        </div>
      </div>
      <div className="progress" role="progressbar" aria-label="Saved" aria-valuenow={p?.downloaded ?? 0} aria-valuemax={p?.target ?? 0}>
        <div style={{ width: `${pct}%` }} />
      </div>
      {stats.length > 0 && (
        <div className="hunt-stats small">
          {stats.map(([k, v]) => (
            <span key={k}>
              {k} <b>{v}</b>
            </span>
          ))}
        </div>
      )}
    </section>
  );
}

export function AgentsGrid({ agents }: { agents: Agent[] }) {
  if (agents.length === 0) return null;
  return (
    <section className="agents-grid" aria-label="Agents">
      {agents.map((a) => {
        const urgent = ['captcha', 'login', 'error', 'limited'].includes(a.state);
        return (
          <div key={a.id} className={`card agent agent-${a.state}`}>
            <div className="row" style={{ flexWrap: 'nowrap' }}>
              <strong className="small">
                Agent {a.id} · {PLATFORM_NAMES[a.platform] ?? a.platform}
              </strong>
              <span className="spacer" />
              <span className="muted small">{a.found} found</span>
            </div>
            <div className="agent-query small" title={a.query}>
              {a.query ? `“${a.query}”` : '—'}
            </div>
            <div className="small agent-state">
              <span className="dot" />
              {AGENT_STATE[a.state] || a.state}
              {a.state === 'scrolling' ? ` · ${a.scrolls} scrolls` : ''}
            </div>
            {urgent && a.note && <div className="small agent-note">{a.note}</div>}
          </div>
        );
      })}
    </section>
  );
}

function CandidateCard({
  modelId,
  c,
  usesReference,
  onMoreLike,
  onPost,
  onStudio,
}: {
  modelId: string;
  c: Candidate;
  usesReference: boolean;
  onMoreLike: (c: Candidate) => void;
  onPost: (path: string) => void;
  onStudio: (path: string) => void;
}) {
  const [thumbBroken, setThumbBroken] = useState(false);
  const local = c.thumb ? api.thumb(modelId, c.thumb) : '';
  const src = local || (!thumbBroken && c.thumbnail_url) || '';
  const hasScore = c.score !== null && c.score !== undefined;
  const look = c.frames_look ?? c.look;
  const meta = [
    c.author && `@${c.author}`,
    c.views != null && `${fmtNumber(c.views)} views`,
    c.likes != null && `${fmtNumber(c.likes)} likes`,
    c.duration && `${Math.round(c.duration)}s`,
  ].filter(Boolean);
  const scored = BEST_STATES.includes(c.status);
  return (
    <article className={`reel-card reel-${c.status}`}>
      <a className="reel-thumb" href={c.url} target="_blank" rel="noreferrer">
        {src ? (
          <img src={src} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setThumbBroken(true)} />
        ) : (
          <span className="reel-thumb-empty" />
        )}
        <span className="badge-pill platform">
          {(PLATFORM_BADGE[c.platform] || c.platform) + (c.kind === 'image' ? ' · image' : '')}
        </span>
        {hasScore && (
          <span
            className={`badge-pill score ${c.score! >= 70 ? 'good' : c.score! >= 40 ? 'meh' : ''}`}
            title={c.quick ? 'Scored quickly (no AI look)' : c.look != null ? `Score: AI ${c.ai_score} + look ${c.look}` : 'AI score'}
          >
            {c.score}
          </span>
        )}
      </a>
      <div className="reel-body">
        <div className={`reel-status small${c.status === 'downloaded' ? ' saved' : ''}`}>{STATUS_TEXT[c.status] || c.status}</div>
        <p className="reel-caption small" title={c.caption || ''}>
          {c.caption || '(no caption yet)'}
        </p>
        <div className="muted small">{meta.join(' · ')}</div>
        {look != null && (
          <div className={`look look-${look >= 70 ? 'high' : look >= 40 ? 'mid' : 'low'}`}>
            <span className="look-bar">
              <span style={{ width: `${look}%` }} />
            </span>
            <span className="small muted">
              {usesReference ? 'Looks ' : 'Picture '}
              {look}% {usesReference ? 'like your reference' : 'matches your description'}
            </span>
          </div>
        )}
        {c.reason && <p className="reel-reason small">{c.reason}</p>}
        <div className="row reel-actions">
          {c.status === 'downloaded' && c.file && (
            <>
              <button type="button" className="btn primary small" onClick={() => onPost(c.file!)}>
                Post
              </button>
              {c.kind !== 'image' && (
                <button type="button" className="btn small" onClick={() => onStudio(c.file!)} title="Make it with your model in AI Studio">
                  AI Studio
                </button>
              )}
            </>
          )}
          {c.kind !== 'image' && scored && (
            <button type="button" className="btn link small" onClick={() => onMoreLike(c)} title="Use this video as a reference for the next hunt">
              More like this
            </button>
          )}
        </div>
      </div>
    </article>
  );
}

export function Feed({
  modelId,
  candidates,
  usesReference,
  onMoreLike,
  onPost,
  onStudio,
  empty,
}: {
  modelId: string;
  candidates: Candidate[];
  usesReference: boolean;
  onMoreLike: (c: Candidate) => void;
  onPost: (path: string) => void;
  onStudio: (path: string) => void;
  empty: React.ReactNode;
}) {
  const [filter, setFilter] = useState<Filter>('best');
  const counts = {
    best: candidates.filter((c) => BEST_STATES.includes(c.status)).length,
    downloaded: candidates.filter((c) => c.status === 'downloaded').length,
    all: candidates.length,
    rejected: candidates.filter((c) => ['skipped', 'failed', 'unchecked'].includes(c.status)).length,
  };
  let shown = candidates;
  if (filter === 'best') {
    shown = candidates.filter((c) => BEST_STATES.includes(c.status)).sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
  } else if (filter === 'downloaded') shown = candidates.filter((c) => c.status === 'downloaded');
  else if (filter === 'rejected') shown = candidates.filter((c) => ['skipped', 'failed', 'unchecked'].includes(c.status));
  const labels: [Filter, string][] = [
    ['best', 'Best'],
    ['downloaded', 'Saved'],
    ['all', 'All'],
    ['rejected', 'Skipped'],
  ];
  return (
    <section className="card">
      <div className="segmented" role="tablist" style={{ marginBottom: 12 }}>
        {labels.map(([id, label]) => (
          <button key={id} role="tab" aria-selected={filter === id} className={filter === id ? 'on' : ''} onClick={() => setFilter(id)}>
            {label}
            {counts[id] ? ` · ${counts[id]}` : ''}
          </button>
        ))}
      </div>
      {candidates.length === 0 ? (
        empty
      ) : shown.length === 0 ? (
        <p className="muted small">Nothing here yet.</p>
      ) : (
        <div className="reel-grid">
          {shown.slice(0, 400).map((c) => (
            <CandidateCard
              key={`${c.platform}:${c.id}`}
              modelId={modelId}
              c={c}
              usesReference={usesReference}
              onMoreLike={onMoreLike}
              onPost={onPost}
              onStudio={onStudio}
            />
          ))}
        </div>
      )}
    </section>
  );
}

export function ActivityLog({ logs, onCopyReport, onOpenLog }: { logs: LogEntry[]; onCopyReport: () => void; onOpenLog: () => void }) {
  return (
    <details className="card log-panel">
      <summary>
        <strong>Activity log</strong>
      </summary>
      <div className="row" style={{ margin: '10px 0' }}>
        <button type="button" className="btn small" onClick={onCopyReport}>
          Copy report
        </button>
        <button type="button" className="btn small" onClick={onOpenLog}>
          Show log file
        </button>
        <span className="muted small">If something isn't working, copy the report and paste it into a chat with Claude.</span>
      </div>
      <div className="log">
        {logs.map((l, i) => (
          <div key={i} className={l.level === 'warn' ? 'warn' : ''}>
            <time>{new Date(l.t * 1000).toLocaleTimeString()}</time> {l.text}
          </div>
        ))}
      </div>
    </details>
  );
}
