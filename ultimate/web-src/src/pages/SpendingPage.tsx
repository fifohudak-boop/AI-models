import { useCallback, useEffect, useState } from 'react';
import type { Model, StudioJob, StudioSpending } from '../types';
import { api } from '../api';
import { useLive } from '../live';

function useMoney(currency: string) {
  return (n: number) => `${currency === 'USD' ? '$' : ''}${n.toFixed(2)}${currency && currency !== 'USD' ? ` ${currency}` : ''}`;
}

// How much this one model has spent on Wan (AI Studio). Only this model's videos — switch models to
// see another's. Wan bills per second of finished video, and only for videos that succeed.
export function SpendingPage({ model, onSettings }: { model: Model; onSettings: () => void }) {
  const [sum, setSum] = useState<StudioSpending | null>(null);
  const [jobs, setJobs] = useState<StudioJob[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [s, j] = await Promise.all([api.studioSpending(model.id), api.studioJobs(model.id)]);
      setSum(s);
      setJobs(j.filter((x) => x.status === 'saved' && x.cost != null));
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [model.id]);

  useEffect(() => {
    load();
  }, [load]);

  useLive((event) => {
    if (event.type === 'studio_job' && event.model === model.id) load();
  });

  const money = useMoney(sum?.currency ?? 'USD');
  const maxMonth = Math.max(1, ...(sum?.perMonth ?? []).map((m) => m.cost));

  return (
    <div>
      <div className="card-head">
        <h1>{model.name}'s spending</h1>
        <button className="btn small" onClick={load}>
          Refresh
        </button>
      </div>

      {error && <div className="notice error">{error}</div>}

      <section className="card">
        <div className="spend-tiles">
          <div className="spend-tile">
            <div className="spend-big">{sum ? money(sum.total) : '—'}</div>
            <div className="muted small">Total on Wan</div>
          </div>
          <div className="spend-tile">
            <div className="spend-big">{sum?.videos ?? 0}</div>
            <div className="muted small">Videos made</div>
          </div>
          <div className="spend-tile">
            <div className="spend-big">{sum ? Math.round(sum.seconds) : 0}s</div>
            <div className="muted small">Video generated</div>
          </div>
          <div className="spend-tile">
            <div className="spend-big">{sum && sum.videos ? money(sum.total / sum.videos) : '—'}</div>
            <div className="muted small">Average per video</div>
          </div>
        </div>
        <p className="muted small" style={{ marginBottom: 0 }}>
          Only {model.name}'s videos, and only the ones that finished — Alibaba charges when a video succeeds, not for
          failed ones. Prices come from the rates you set in{' '}
          <button type="button" className="btn link small" onClick={onSettings}>
            Settings → AI Studio
          </button>
          .
        </p>
      </section>

      {sum && sum.perMonth.length > 0 && (
        <section className="card">
          <h2>By month</h2>
          <div className="spend-bars">
            {sum.perMonth.map((mo) => (
              <div key={mo.month} className="spend-bar-row">
                <span className="spend-bar-label small">{mo.month}</span>
                <span className="spend-bar-track">
                  <span className="spend-bar-fill" style={{ width: `${(100 * mo.cost) / maxMonth}%` }} />
                </span>
                <span className="spend-bar-value small">
                  {money(mo.cost)} · {mo.videos}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      {sum && Object.keys(sum.perResolution).length > 0 && (
        <section className="card">
          <h2>By quality</h2>
          <table className="spend-table">
            <thead>
              <tr>
                <th>Quality</th>
                <th>Videos</th>
                <th>Seconds</th>
                <th>Cost</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(sum.perResolution).map(([res, r]) => (
                <tr key={res}>
                  <td>{res}</td>
                  <td>{r.videos}</td>
                  <td>{Math.round(r.seconds)}s</td>
                  <td>{money(r.cost)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <section className="card">
        <h2>Every video</h2>
        {jobs.length === 0 ? (
          <p className="muted small">
            Nothing yet. When {model.name}'s AI Studio videos finish, each one's cost shows up here.
          </p>
        ) : (
          <div className="stack">
            {jobs.map((job) => (
              <div key={job.id} className="row spend-item">
                <span className="small">{new Date(job.createdAt).toLocaleDateString()}</span>
                <span className="small muted">
                  {job.resolution} · {job.seconds ?? '?'}s · {job.mode === 'reference' ? 'reference' : job.mode}
                </span>
                <span className="small" style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {job.prompt || (job.videos[0] ? job.videos[0].split('/').pop() : '')}
                </span>
                <strong className="small">{money(job.cost ?? 0)}</strong>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
